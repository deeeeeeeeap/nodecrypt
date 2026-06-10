// Import necessary modules
// 导入必要的模块
import { deflate, inflate } from 'fflate';
import { showFileUploadModal } from './util.fileUpload.js';
import { t } from './util.i18n.js';

// 分卷大小统一配置
const DEFAULT_VOLUME_SIZE = 256 * 1024; // 256KB
const MIN_VOLUME_SIZE = 32 * 1024;
const MAX_FILE_VOLUMES = 32768;
const MAX_VOLUME_DATA_LENGTH = Math.ceil(DEFAULT_VOLUME_SIZE / 3) * 4 + 1024;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_FILE_COUNT = 200;
const DIRECT_TRANSFER_THRESHOLD = 8 * 1024 * 1024;
const MAX_SINGLE_FILE_SIZE = 200 * 1024 * 1024; // 200MB：base64 分卷全量驻留内存，1GB 会撑爆浏览器 / volumes stay in memory, 1GB would exhaust the browser
const MAX_ARCHIVE_FAST_PATH_SIZE = 64 * 1024 * 1024;
const COMPLETED_TRANSFER_TTL_MS = 60 * 60 * 1000;
const RESUMABLE_TRANSFER_TTL_MS = 10 * 60 * 1000;
const MAX_NACK_RANGES = 64;
const MAX_NACK_CHUNKS_PER_REQUEST = 256;
const MISSING_CHUNK_NACK_DELAY_MS = 3000;
const MIN_REPAIR_RESPONSE_TIMEOUT_MS = 6000;
const MAX_REPAIR_RESPONSE_TIMEOUT_MS = 60000;
const REPAIR_RECONNECT_GRACE_TIMEOUT_MS = 15000;
const REPAIR_TIMEOUT_BYTES_PER_MS = 1024;
const FAST_DEFLATE_LEVEL = 3;
const PUBLIC_PAYLOAD_SAFETY_FACTOR = 3;
const FILE_ID_PATTERN = /^file_[a-f0-9-]{16,80}$/i;
const FILE_VOLUME_YIELD_INTERVAL = 4;
const DIRECT_TRANSFER_EXTENSIONS = new Set([
	'7z', 'avi', 'br', 'bz2', 'gif', 'gz', 'heic', 'jpeg', 'jpg', 'm4a', 'm4v',
	'mkv', 'mov', 'mp3', 'mp4', 'ogg', 'png', 'rar', 'webm', 'webp', 'xz', 'zip'
]);

// File transfer state management
// 文件传输状态管理
window.fileTransfers = new Map();
const fileProgressFrames = new Map();

function getRepairStatusText(transfer) {
	if (!transfer) return '';
	if (transfer.status === 'completed') {
		return transfer.nackState && transfer.nackState.requestSeq > 0 ?
			'Repaired' :
			'Completed'
	}
	if (transfer.repairStatus === 'failed') return 'Repair failed';
	if (transfer.repairStatus === 'waiting' || transfer.repairStatus === 'requesting') return 'Waiting for repair';
	if (transfer.status === 'sending') return `Sending ${transfer.sentVolumes || 0}/${transfer.totalVolumes || 0}`;
	if (transfer.status === 'receiving') {
		const receivedCount = transfer.receivedVolumes ? transfer.receivedVolumes.size : 0;
		return `Receiving ${receivedCount}/${transfer.totalVolumes || 0}`
	}
	return ''
}

function countMissingRangeChunks(ranges) {
	if (!Array.isArray(ranges)) return 0;
	return ranges.reduce((sum, range) => {
		if (!Array.isArray(range) || range.length < 2) return sum;
		const start = Number(range[0]);
		const end = Number(range[1]);
		if (!Number.isFinite(start) || !Number.isFinite(end)) return sum;
		return sum + Math.max(0, end - start + 1)
	}, 0)
}

function getRepairResponseTimeoutMs(transfer, missingRanges = null) {
	const missingChunks = countMissingRangeChunks(missingRanges);
	const chunkSize = Number.isFinite(transfer?.chunkSize) && transfer.chunkSize > 0 ? transfer.chunkSize : DEFAULT_VOLUME_SIZE;
	const estimated = missingChunks > 0 ?
		Math.ceil((missingChunks * chunkSize) / REPAIR_TIMEOUT_BYTES_PER_MS) :
		MIN_REPAIR_RESPONSE_TIMEOUT_MS;
	return Math.max(MIN_REPAIR_RESPONSE_TIMEOUT_MS, Math.min(MAX_REPAIR_RESPONSE_TIMEOUT_MS, estimated))
}

export function getFileTransferPresentation(fileId, isSender = false) {
	const transfer = window.fileTransfers ? window.fileTransfers.get(fileId) : null;
	if (!transfer) {
		return {
			transfer,
			statusText: isSender ? '' : 'File data is not available. Ask the sender to resend it.',
			progressWidth: '0%',
			showProgress: !isSender,
			showDownload: false,
			state: isSender ? 'sender-unavailable' : 'unavailable'
		}
	}

	const totalVolumes = transfer.totalVolumes || 0;
	const sentVolumes = transfer.sentVolumes || 0;
	const receivedVolumes = transfer.receivedVolumes ? transfer.receivedVolumes.size : 0;
	const progressCount = transfer.direction === 'send' ? sentVolumes : receivedVolumes;
	const progress = totalVolumes > 0 ? Math.min(100, Math.max(0, (progressCount / totalVolumes) * 100)) : 0;
	const repairState = transfer.repairStatus || '';
	const wasRepaired = repairState === 'completed' && Boolean(transfer.nackState && transfer.nackState.requestSeq > 0);
	let state = transfer.status || '';
	if (repairState === 'failed') state = 'repair-failed';
	else if (repairState === 'waiting' || repairState === 'requesting') state = 'repair-waiting';
	else if (transfer.status === 'completed' && wasRepaired) state = 'repaired';

	return {
		transfer,
		statusText: getRepairStatusText(transfer),
		progressWidth: `${progress}%`,
		showProgress: transfer.status !== 'completed' || wasRepaired || repairState === 'failed',
		showDownload: transfer.status === 'completed' && transfer.direction !== 'send',
		state
	}
}

// Base64 encoding for binary data (more efficient than hex)
// Base64编码用于二进制数据（比十六进制更高效）
function arrayBufferToBase64(buffer) {
	const uint8Array = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to avoid call stack limits
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	
	return btoa(binary);
}

// Base64 decoding back to binary
// Base64解码回二进制数据
function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const uint8Array = new Uint8Array(binary.length);
	
	for (let i = 0; i < binary.length; i++) {
		uint8Array[i] = binary.charCodeAt(i);
	}
	
	return uint8Array;
}

// Generate unique file ID
// 生成唯一文件ID
function generateFileId() {
	if (crypto.randomUUID) {
		return `file_${crypto.randomUUID()}`
	}

	const randomBytes = crypto.getRandomValues(new Uint8Array(16));
	return 'file_' + Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Calculate SHA-256 hash for data integrity verification
// 计算SHA-256哈希值用于数据完整性验证
async function calculateHash(data) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



// Compress file into volumes with optimized compression
// 将文件压缩为分卷，优化压缩算法
async function compressFileToVolumes(file, volumeSize = DEFAULT_VOLUME_SIZE) { // 96KB原始数据，base64后约128KB
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = async function(e) {
			const arrayBuffer = new Uint8Array(e.target.result);
			
			try {
				// Calculate hash of original file for integrity
				const originalHash = await calculateHash(arrayBuffer);
				
				// Use single compression pass with balanced compression
				// 使用单次压缩，平衡压缩率和速度
				deflate(arrayBuffer, { 
					level: FAST_DEFLATE_LEVEL, // 平衡压缩级别
					mem: 8    // 合理内存使用
				}, (err, compressed) => {
					if (err) {
						reject(err);
						return;
					}
					
					// Split compressed data into volumes
					const volumes = [];
					for (let i = 0; i < compressed.length; i += volumeSize) {
						const volume = compressed.slice(i, i + volumeSize);
						volumes.push(arrayBufferToBase64(volume));
					}
					
					resolve({
						volumes,
						originalSize: file.size,
						compressedSize: compressed.length,
						originalHash
					});
				});
			} catch (hashError) {
				reject(hashError);
			}
		};
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Compress multiple files into a single archive with volumes
// 将多个文件压缩为单个分卷归档
async function compressFilesToArchive(files, volumeSize = DEFAULT_VOLUME_SIZE) {	try {
		// Create a simple archive format: [file1_size][file1_name_length][file1_name][file1_data][file2_size]...
		// 创建简单的归档格式
		const archiveData = [];
		const fileManifest = [];
		
		for (const file of files) {
			const fileBuffer = await readFileAsArrayBuffer(file);
			const nameBytes = new TextEncoder().encode(file.name);
			
			// Add file metadata to manifest
			fileManifest.push({
				name: file.name,
				size: file.size,
				offset: 0 // Will be calculated later
			});
			
			// File format: [name_length(4)][name][size(8)][data]
			// Use separate arrays to avoid alignment issues
			const nameLengthBytes = new Uint8Array(4);
			const nameLengthView = new DataView(nameLengthBytes.buffer);
			nameLengthView.setUint32(0, nameBytes.length, true); // little endian
			
			const fileSizeBytes = new Uint8Array(8);
			const fileSizeView = new DataView(fileSizeBytes.buffer);
			fileSizeView.setBigUint64(0, BigInt(file.size), true); // little endian
			
			archiveData.push(
				nameLengthBytes,
				nameBytes,
				fileSizeBytes,
				new Uint8Array(fileBuffer)
			);
		}		
		// Combine all data
		const totalLength = archiveData.reduce((sum, part) => sum + part.length, 0);
		
		const combinedData = new Uint8Array(totalLength);
		let offset = 0;
		
		for (const part of archiveData) {
			combinedData.set(part, offset);
			offset += part.length;
		}
		
		// Calculate hash of the entire archive
		const archiveHash = await calculateHash(combinedData);
		
		// Compress the archive
		return new Promise((resolve, reject) => {
			deflate(combinedData, { 
				level: FAST_DEFLATE_LEVEL,
				mem: 8
			}, (err, compressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Split compressed data into volumes
				const volumes = [];
				for (let i = 0; i < compressed.length; i += volumeSize) {
					const volume = compressed.slice(i, i + volumeSize);
					volumes.push(arrayBufferToBase64(volume));
				}
				
				resolve({
					volumes,
					originalSize: totalLength,
					compressedSize: compressed.length,
					archiveHash,
					fileCount: files.length,
					fileManifest
				});
			});
		});
	} catch (error) {
		throw new Error(`Archive compression failed: ${error.message}`);
	}
}

// Helper function to read file as array buffer
// 辅助函数：将文件读取为ArrayBuffer
function getFileExtension(fileName) {
	const parts = String(fileName || '').toLowerCase().split('.');
	return parts.length > 1 ? parts.pop() : ''
}

function shouldUseDirectTransfer(file) {
	return file.size > 0 && (file.size >= DIRECT_TRANSFER_THRESHOLD || DIRECT_TRANSFER_EXTENSIONS.has(getFileExtension(file.name)))
}

function alignVolumeSize(size) {
	return Math.max(MIN_VOLUME_SIZE, Math.min(DEFAULT_VOLUME_SIZE, Math.floor(size / MIN_VOLUME_SIZE) * MIN_VOLUME_SIZE || MIN_VOLUME_SIZE))
}

function chooseVolumeSize(recipientCount = 1) {
	const recipients = Math.max(1, Number.isFinite(recipientCount) ? recipientCount : 1);
	const budgetPerRecipient = Math.floor((8 * 1024 * 1024) / (recipients * PUBLIC_PAYLOAD_SAFETY_FACTOR));
	return alignVolumeSize(budgetPerRecipient)
}

function countVolumes(byteLength, volumeSize) {
	return Math.max(1, Math.ceil(byteLength / volumeSize))
}

async function readFileSliceAsUint8Array(file, start, end) {
	return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

function yieldToBrowser() {
	return new Promise(resolve => setTimeout(resolve, 0))
}

function scheduleCompletedTransferCleanup(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.cleanupTimer) return;
	transfer.cleanupTimer = setTimeout(() => {
		const latest = window.fileTransfers.get(fileId);
		if (latest && latest.status === 'completed') {
			window.fileTransfers.delete(fileId)
		}
	}, COMPLETED_TRANSFER_TTL_MS)
}

function scheduleSourceFileRelease(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || !transfer.sourceFile || transfer.sourceFileReleaseTimer) return;
	const releaseAfterMs = Math.max(0, (transfer.resumeUntil || Date.now()) - Date.now());
	transfer.sourceFileReleaseTimer = setTimeout(() => {
		const latest = window.fileTransfers.get(fileId);
		if (latest && latest.transferMode === 'direct') {
			latest.sourceFile = null;
			latest.sourceFileReleaseTimer = null
		}
	}, releaseAfterMs)
}

function refreshSourceFileRepairWindow(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer || transfer.transferMode !== 'direct' || !transfer.sourceFile) return;
	transfer.resumeUntil = Date.now() + RESUMABLE_TRANSFER_TTL_MS;
	if (transfer.sourceFileReleaseTimer) {
		clearTimeout(transfer.sourceFileReleaseTimer);
		transfer.sourceFileReleaseTimer = null
	}
	scheduleSourceFileRelease(fileId)
}

function readFileAsArrayBuffer(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve(e.target.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

function combineVolumeData(volumes) {
	const combinedData = volumes.map(volume => base64ToArrayBuffer(volume));
	const totalLength = combinedData.reduce((sum, arr) => sum + arr.length, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;

	for (const data of combinedData) {
		combined.set(data, offset);
		offset += data.length;
	}
	return combined
}

function saveUint8ArrayAsFile(data, fileName) {
	const blob = new Blob([data]);
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

async function downloadRawVolumesToFile(volumes, fileName, originalHash = null) {
	const data = combineVolumeData(volumes);
	if (originalHash) {
		const calculatedHash = await calculateHash(data);
		if (calculatedHash !== originalHash) {
			throw new Error('File integrity check failed: hash mismatch')
		}
	}
	saveUint8ArrayAsFile(data, fileName)
}

// Decompress volumes back to file
// 将分卷解压回文件
async function decompressVolumesToFile(volumes, fileName, originalHash = null) {
	try {
		const compressed = combineVolumeData(volumes);
				// Decompress
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify hash if provided
				if (originalHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== originalHash) {
							reject(new Error('File integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('File integrity check failed: ' + hashError.message));
						return;
					}
				}
				
				saveUint8ArrayAsFile(decompressed, fileName);
				
				resolve();
			});
		});
	} catch (error) {
		console.error('Decompression error:', error);
		throw error;
	}
}

// Decompress archive volumes to multiple files
// 将归档分卷解压为多个文件
async function decompressArchiveToFiles(volumes, fileManifest, archiveHash = null) {
	try {
		const compressed = combineVolumeData(volumes);
		
		// Decompress archive
		return new Promise((resolve, reject) => {
			inflate(compressed, async (err, decompressed) => {
				if (err) {
					reject(err);
					return;
				}
				
				// Verify archive hash if provided
				if (archiveHash) {
					try {
						const calculatedHash = await calculateHash(decompressed);
						if (calculatedHash !== archiveHash) {
							reject(new Error('Archive integrity check failed: hash mismatch'));
							return;
						}
					} catch (hashError) {
						reject(new Error('Archive integrity check failed: ' + hashError.message));
						return;
					}
				}
						// Extract files from archive
				let dataOffset = 0;
				const extractedFiles = [];
						for (const fileInfo of fileManifest) {
					// Read file metadata: [name_length(4)][name][size(8)][data]
					const nameLengthBytes = decompressed.slice(dataOffset, dataOffset + 4);
					const nameLengthView = new DataView(nameLengthBytes.buffer);
					const nameLength = nameLengthView.getUint32(0, true); // little endian
					dataOffset += 4;
					
					const nameBytes = decompressed.slice(dataOffset, dataOffset + nameLength);
					const fileName = new TextDecoder().decode(nameBytes);
					dataOffset += nameLength;
					
					// Use DataView to read BigUint64 safely
					const fileSizeBytes = decompressed.slice(dataOffset, dataOffset + 8);
					const fileSizeView = new DataView(fileSizeBytes.buffer);
					const fileSize = Number(fileSizeView.getBigUint64(0, true)); // little endian
					dataOffset += 8;
					
					const fileData = decompressed.slice(dataOffset, dataOffset + fileSize);
					dataOffset += fileSize;
					
					// Create and download file
					const blob = new Blob([fileData]);
					const url = URL.createObjectURL(blob);
					const a = document.createElement('a');
					a.href = url;
					a.download = fileName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
					
					extractedFiles.push(fileName);
					
					// Add small delay between downloads to avoid overwhelming the browser
					await new Promise(resolve => setTimeout(resolve, 100));
				}
				
				resolve(extractedFiles);
			});
		});
	} catch (error) {
		console.error('Archive decompression error:', error);
		throw error;
	}
}

// Setup file sending functionality
// 设置文件发送功能
export function setupFileSend({
	inputSelector,
	attachBtnSelector,
	fileInputSelector,
	onSend,
	getCurrentUserName = null,
	getRecipientCount = null,
	getTransferContext = null
}) {
	const attachBtn = document.querySelector(attachBtnSelector);
	
	if (attachBtn) {
		// 点击附件按钮显示文件上传模态框
		// Click attach button to show file upload modal
		attachBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			
			showFileUploadModal(async (files) => {
				// 传递 userName 给 onSend
				const userName = typeof getCurrentUserName === 'function' ? (getCurrentUserName() || '') : '';
				const recipientCount = typeof getRecipientCount === 'function' ? getRecipientCount() : 1;
				const transferContext = typeof getTransferContext === 'function' ? (getTransferContext() || {}) : {};
				await handleFilesUpload(files, async (msg) => {
					// 合并 userName 字段
					await onSend({ ...msg, userName }, transferContext);
				}, { recipientCount, transferContext });
			});
		});
	}
}

export function isSafeIntegerInRange(value, min, max) {
	return Number.isSafeInteger(value) && value >= min && value <= max
}

export function isValidFileId(fileId) {
	return typeof fileId === 'string' && FILE_ID_PATTERN.test(fileId)
}

function isValidOptionalHash(value) {
	return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128)
}

function isValidFileStartMessage(message) {
	if (!message || typeof message !== 'object') return false;
	if (!isValidFileId(message.fileId)) return false;
	if (typeof message.fileName !== 'string' || message.fileName.length === 0 || message.fileName.length > MAX_FILE_NAME_LENGTH) return false;
	if (!isSafeIntegerInRange(message.originalSize, 0, Number.MAX_SAFE_INTEGER)) return false;
	if (!isSafeIntegerInRange(message.compressedSize, 0, Number.MAX_SAFE_INTEGER)) return false;
	if (!isSafeIntegerInRange(message.totalVolumes, 1, MAX_FILE_VOLUMES)) return false;
	if (!isValidOptionalHash(message.originalHash) || !isValidOptionalHash(message.archiveHash)) return false;
	if (message.compression !== undefined && !['deflate', 'none'].includes(message.compression)) return false;
	if (message.fileCount !== undefined && !isSafeIntegerInRange(message.fileCount, 1, MAX_FILE_COUNT)) return false;
	if (message.fileManifest !== undefined && (!Array.isArray(message.fileManifest) || message.fileManifest.length > MAX_FILE_COUNT)) return false;
	return true
}

function isValidFileVolumeMessage(message, transfer) {
	if (!message || !transfer) return false;
	if (!isValidFileId(message.fileId)) return false;
	if (!isSafeIntegerInRange(message.volumeIndex, 0, transfer.totalVolumes - 1)) return false;
	if (typeof message.volumeData !== 'string' || message.volumeData.length === 0 || message.volumeData.length > MAX_VOLUME_DATA_LENGTH) return false;
	return !transfer.receivedVolumes.has(message.volumeIndex)
}

export function getMissingRanges(transfer, maxRanges = MAX_NACK_RANGES, maxChunks = MAX_NACK_CHUNKS_PER_REQUEST, maxIndex = null) {
	const ranges = [];
	if (!transfer || !transfer.receivedVolumes || !isSafeIntegerInRange(transfer.totalVolumes, 1, MAX_FILE_VOLUMES)) {
		return ranges
	}
	const lastIndex = maxIndex === null ? transfer.totalVolumes - 1 : Math.min(maxIndex, transfer.totalVolumes - 1);
	if (!isSafeIntegerInRange(lastIndex, 0, transfer.totalVolumes - 1)) {
		return ranges
	}

	let rangeStart = -1;
	let rangeEnd = -1;
	let chunkCount = 0;

	function pushRange() {
		if (rangeStart < 0) return true;
		if (ranges.length >= maxRanges) return false;
		ranges.push([rangeStart, rangeEnd]);
		rangeStart = -1;
		rangeEnd = -1;
		return ranges.length < maxRanges
	}

	for (let index = 0; index <= lastIndex; index++) {
		const hasVolumeData = !Array.isArray(transfer.volumeData) || typeof transfer.volumeData[index] === 'string';
		if (transfer.receivedVolumes.has(index) && hasVolumeData) {
			if (!pushRange()) break;
			continue
		}
		if (chunkCount >= maxChunks) {
			pushRange();
			break
		}
		if (rangeStart < 0) {
			rangeStart = index;
			rangeEnd = index
		} else {
			rangeEnd = index
		}
		chunkCount += 1
	}
	pushRange();
	return ranges
}

function advanceNextExpectedVolume(transfer) {
	if (!transfer || !transfer.receivedVolumes || !isSafeIntegerInRange(transfer.totalVolumes, 1, MAX_FILE_VOLUMES)) {
		return
	}
	let nextExpected = Number.isSafeInteger(transfer.nextExpectedVolume) ? transfer.nextExpectedVolume : 0;
	while (
		nextExpected < transfer.totalVolumes &&
		transfer.receivedVolumes.has(nextExpected) &&
		(!Array.isArray(transfer.volumeData) || typeof transfer.volumeData[nextExpected] === 'string')
	) {
		nextExpected += 1
	}
	transfer.nextExpectedVolume = nextExpected
}

function requestGapRepairIfNeeded(transfer, volumeIndex, options = {}) {
	if (!transfer || transfer.compression !== 'none') {
		return
	}
	const expected = Number.isSafeInteger(transfer.nextExpectedVolume) ? transfer.nextExpectedVolume : 0;
	if (volumeIndex > expected) {
		const missingBeforeThisVolume = getMissingRanges(transfer, MAX_NACK_RANGES, MAX_NACK_CHUNKS_PER_REQUEST, volumeIndex - 1);
		if (missingBeforeThisVolume.length > 0) {
			void requestMissingFileVolumes(transfer, 'gap', options, missingBeforeThisVolume)
		}
	}
	advanceNextExpectedVolume(transfer)
}

export function normalizeMissingRanges(ranges, totalVolumes) {
	if (!Array.isArray(ranges) || !isSafeIntegerInRange(totalVolumes, 1, MAX_FILE_VOLUMES)) {
		return []
	}

	const normalized = [];
	let requestedChunks = 0;
	for (const range of ranges) {
		if (!Array.isArray(range) || range.length !== 2) {
			return []
		}
		const start = range[0];
		const end = range[1];
		if (!isSafeIntegerInRange(start, 0, totalVolumes - 1) || !isSafeIntegerInRange(end, start, totalVolumes - 1)) {
			return []
		}
		if (normalized.length >= MAX_NACK_RANGES || requestedChunks >= MAX_NACK_CHUNKS_PER_REQUEST) {
			break
		}
		const remaining = MAX_NACK_CHUNKS_PER_REQUEST - requestedChunks;
		const cappedEnd = Math.min(end, start + remaining - 1);
		normalized.push([start, cappedEnd]);
		requestedChunks += cappedEnd - start + 1
	}
	return normalized
}

function canRepairDirectTransfer(transfer) {
	return Boolean(
		transfer &&
		transfer.direction === 'send' &&
		transfer.transferMode === 'direct' &&
		transfer.compression === 'none' &&
		transfer.sourceFile &&
		isSafeIntegerInRange(transfer.chunkSize, MIN_VOLUME_SIZE, DEFAULT_VOLUME_SIZE) &&
		Date.now() <= (transfer.resumeUntil || 0)
	)
}

function reportFileSendLimit(message) {
	if (window.addSystemMsg) {
		window.addSystemMsg(`Failed to send files: ${message}`);
	}
}

export function validateSelectedFiles(files) {
	if (files.length > MAX_FILE_COUNT) {
		return `Too many files selected. Maximum is ${MAX_FILE_COUNT}.`
	}
	for (const file of files) {
		if (typeof file.name !== 'string' || file.name.length === 0 || file.name.length > MAX_FILE_NAME_LENGTH) {
			return `File name is too long. Maximum is ${MAX_FILE_NAME_LENGTH} characters.`
		}
		if (!Number.isFinite(file.size) || file.size < 0 || file.size > MAX_SINGLE_FILE_SIZE) {
			return `File is too large. Maximum is ${formatFileSize(MAX_SINGLE_FILE_SIZE)} per file.`
		}
	}
	return ''
}

function validateVolumeCount(volumes) {
	if (!Array.isArray(volumes) || !isSafeIntegerInRange(volumes.length, 1, MAX_FILE_VOLUMES)) {
		return `File is too large to transfer safely. Maximum is ${MAX_FILE_VOLUMES} chunks.`
	}
	return ''
}

function validateVolumeTotal(totalVolumes) {
	if (!isSafeIntegerInRange(totalVolumes, 1, MAX_FILE_VOLUMES)) {
		return `File is too large to transfer safely. Maximum is ${MAX_FILE_VOLUMES} chunks.`
	}
	return ''
}

async function sendDirectFileVolumes(fileId, file, volumeSize, totalVolumes, onSend, updateProgress) {
	const fileTransfer = window.fileTransfers.get(fileId);
	if (!fileTransfer) return;

	for (let i = 0; i < totalVolumes; i++) {
		const start = i * volumeSize;
		const end = Math.min(start + volumeSize, file.size);
		const volume = await readFileSliceAsUint8Array(file, start, end);
		await onSend({
			type: 'file_volume',
			fileId,
			volumeIndex: i,
			volumeData: arrayBufferToBase64(volume),
			isLast: i === totalVolumes - 1
		});

		fileTransfer.sentVolumes = i + 1;
		updateFileProgress(fileId);
		if ((i + 1) % FILE_VOLUME_YIELD_INTERVAL === 0) {
			await yieldToBrowser()
		}
	}

	await onSend({
		type: 'file_complete',
		fileId,
		totalVolumes
	});

	fileTransfer.status = 'completed';
	refreshSourceFileRepairWindow(fileId);
	scheduleCompletedTransferCleanup(fileId);
	updateFileProgress(fileId);
	updateProgress(`Sent ${file.name} successfully`);
}

async function sendSingleFileTransfer(file, onSend, updateProgress, volumeSize, transferContext = {}) {
	const fileId = generateFileId();
	const useDirect = shouldUseDirectTransfer(file);

	if (useDirect) {
		const totalVolumes = countVolumes(file.size, volumeSize);
		const volumeError = validateVolumeTotal(totalVolumes);
		if (volumeError) {
			reportFileSendLimit(volumeError);
			return
		}

		const fileTransfer = {
			fileId,
			fileName: file.name,
			direction: 'send',
			scope: transferContext.scope || 'public',
			roomIndex: transferContext.roomIndex,
			targetClientId: transferContext.targetClientId || null,
			targetClientName: transferContext.targetClientName || null,
			originalSize: file.size,
			compressedSize: file.size,
			totalVolumes,
			sentVolumes: 0,
			status: 'sending',
			compression: 'none',
			transferMode: 'direct',
			sourceFile: file,
			chunkSize: volumeSize,
			resumeUntil: Date.now() + RESUMABLE_TRANSFER_TTL_MS,
			resentVolumes: 0
		};

		window.fileTransfers.set(fileId, fileTransfer);
		refreshSourceFileRepairWindow(fileId);

		await onSend({
			type: 'file_start',
			fileId,
			fileName: file.name,
			originalSize: file.size,
			compressedSize: file.size,
			totalVolumes,
			compression: 'none',
			transferMode: 'direct',
			chunkSize: volumeSize
		});

		await sendDirectFileVolumes(fileId, file, volumeSize, totalVolumes, onSend, updateProgress);
		return
	}

	const { volumes, originalSize, compressedSize, originalHash } = await compressFileToVolumes(file, volumeSize);
	const volumeError = validateVolumeCount(volumes);
	if (volumeError) {
		reportFileSendLimit(volumeError);
		return
	}

	const fileTransfer = {
		fileId,
		fileName: file.name,
		direction: 'send',
		scope: transferContext.scope || 'public',
		roomIndex: transferContext.roomIndex,
		targetClientId: transferContext.targetClientId || null,
		targetClientName: transferContext.targetClientName || null,
		originalSize,
		compressedSize,
		totalVolumes: volumes.length,
		sentVolumes: 0,
		status: 'sending',
		originalHash,
		compression: 'deflate',
		transferMode: 'compressed',
		chunkSize: volumeSize
	};

	window.fileTransfers.set(fileId, fileTransfer);

	await onSend({
		type: 'file_start',
		fileId,
		fileName: file.name,
		originalSize,
		compressedSize,
		totalVolumes: volumes.length,
		originalHash,
		compression: 'deflate',
		transferMode: 'compressed',
		chunkSize: volumeSize
	});

	await sendVolumes(fileId, volumes, onSend, updateProgress, file.name);
}

// Handle files upload
// 处理文件上传
async function handleFilesUpload(files, onSend, options = {}) {
	if (!files || files.length === 0) return;

	const selectedFilesError = validateSelectedFiles(files);
	if (selectedFilesError) {
		reportFileSendLimit(selectedFilesError);
		return
	}
	
	const recipientCount = Math.max(1, Number(options.recipientCount) || 1);
	const volumeSize = chooseVolumeSize(recipientCount);
	const transferContext = options.transferContext || {};
	
	try {
		// Show compression progress
		let progressElement = null;
		
		function showProgress(message) {
			// 删除系统提示
		}
		
		function updateProgress(message) {
			// 删除系统提示
		}
		
		const totalSelectedSize = files.reduce((sum, file) => sum + file.size, 0);
		const sendIndividually = files.length === 1 ||
			totalSelectedSize > MAX_ARCHIVE_FAST_PATH_SIZE ||
			files.some(file => shouldUseDirectTransfer(file));

		if (sendIndividually) {
			for (const file of files) {
				showProgress();
				await sendSingleFileTransfer(file, onSend, updateProgress, volumeSize, transferContext);
				await yieldToBrowser();
			}
		} else {
			// Multiple files upload - create archive
			showProgress();
			
			const fileId = generateFileId();
			const { volumes, originalSize, compressedSize, archiveHash, fileCount, fileManifest } = await compressFilesToArchive(files, volumeSize);
			const volumeError = validateVolumeCount(volumes);
			if (volumeError) {
				reportFileSendLimit(volumeError);
				return
			}
			
			updateProgress();
			
			// Create file transfer state for archive
			const fileTransfer = {
				fileId,
				fileName: `${files.length} files.zip`, // Virtual archive name
				direction: 'send',
				scope: transferContext.scope || 'public',
				roomIndex: transferContext.roomIndex,
				targetClientId: transferContext.targetClientId || null,
				targetClientName: transferContext.targetClientName || null,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				sentVolumes: 0,
				status: 'sending',
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true,
				compression: 'deflate',
				transferMode: 'archive',
				chunkSize: volumeSize
			};
			
			window.fileTransfers.set(fileId, fileTransfer);
			
			// Send archive start message
			await onSend({
				type: 'file_start',
				fileId,
				fileName: `${files.length} files`,
				originalSize,
				compressedSize,
				totalVolumes: volumes.length,
				archiveHash,
				fileCount,
				fileManifest,
				isArchive: true,
				compression: 'deflate',
				transferMode: 'archive',
				chunkSize: volumeSize
			});
			
			// Send volumes
			await sendVolumes(fileId, volumes, onSend, updateProgress, `${files.length} files`);
		}
		
	} catch (error) {
		console.error('File compression error:', error);
		if (window.addSystemMsg) {
			window.addSystemMsg(`${t('system.file_send_failed', 'Failed to send files:')} ${error.message}`);
		}
	}
}

// Send volumes with progress tracking
// 发送分卷并跟踪进度
async function sendVolumes(fileId, volumes, onSend, updateProgress, fileName) {
	const fileTransfer = window.fileTransfers.get(fileId);
	if (!fileTransfer) return;
	
	for (let i = 0; i < volumes.length; i++) {
		await onSend({
			type: 'file_volume',
			fileId,
			volumeIndex: i,
			volumeData: volumes[i],
			isLast: i === volumes.length - 1
		});

		fileTransfer.sentVolumes = i + 1;
		updateFileProgress(fileId);

		if ((i + 1) % FILE_VOLUME_YIELD_INTERVAL === 0) {
			await yieldToBrowser()
		}
	}

	await onSend({
		type: 'file_complete',
		fileId,
		totalVolumes: volumes.length
	});

	fileTransfer.status = 'completed';
	scheduleCompletedTransferCleanup(fileId);
	updateFileProgress(fileId);
	updateProgress(`✓ Sent ${fileName} successfully`);
}

// Update file progress in chat
// 更新聊天中的文件进度
function updateFileProgress(fileId, immediate = false) {
	if (!immediate && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
		if (fileProgressFrames.has(fileId)) return;
		const frame = window.requestAnimationFrame(() => {
			fileProgressFrames.delete(fileId);
			updateFileProgress(fileId, true)
		});
		fileProgressFrames.set(fileId, frame);
		return
	}
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) return;
	const elements = document.querySelectorAll(`[data-file-id="${fileId}"]`);
	elements.forEach(element => {
		const progressContainer = element.querySelector('.file-progress-container');
		const progressBar = element.querySelector('.file-progress');
		const statusText = element.querySelector('.file-status');
		const downloadBtn = element.querySelector('.file-download-btn');
		const transferIsSender = transfer.direction === 'send';
		const presentation = getFileTransferPresentation(fileId, transferIsSender);
		element.setAttribute('data-file-state', presentation.state || '');
		element.className = element.className.replace(/\bfile-state-[^\s]+/g, '').trim();
		if (presentation.state) {
			element.classList.add(`file-state-${presentation.state}`)
		}
		if (progressContainer) {
			progressContainer.style.display = presentation.showProgress ? 'block' : 'none';
			progressContainer.classList.remove('fade-out')
		}
		if (progressBar) progressBar.style.width = presentation.progressWidth;
		if (statusText) statusText.textContent = presentation.statusText;
		if (downloadBtn) {
			if (presentation.showDownload) {
				downloadBtn.style.display = 'flex';
				downloadBtn.classList.add('show');
				downloadBtn.disabled = false
			} else {
				downloadBtn.classList.remove('show', 'animate-in');
				downloadBtn.style.display = 'none'
			}
		}
	});
}

// Handle incoming file messages
// 处理接收到的文件消息
export function handleFileMessage(message, isPrivate = false, options = {}) {
	if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
	const { type } = message;
	const renderMessage = options.renderMessage !== false;
	
	switch (type) {
		case 'file_start':
			handleFileStart(message, isPrivate, renderMessage, options);
			break;
		case 'file_volume':
			handleFileVolume(message, options);
			break;
		case 'file_complete':
			handleFileComplete(message, options);
			break;
		case 'file_nack':
			void handleFileNack(message, options);
			break;
	}
}

// Handle file start message
// 处理文件开始消息
function handleFileStart(message, isPrivate, renderMessage = true, options = {}) {
	const { fileId, fileName, originalSize, compressedSize, totalVolumes, originalHash, archiveHash, fileCount, fileManifest, isArchive, userName, compression = 'deflate', transferMode = compression === 'none' ? 'direct' : 'compressed', chunkSize } = message;
	if (!isValidFileStartMessage(message)) {
		return
	}
	
	const fileTransfer = {
		fileId,
		fileName,
		direction: 'receive',
		scope: isPrivate ? 'private' : 'public',
		roomIndex: options.roomIndex,
		senderClientId: options.senderClientId || null,
		senderUserName: options.senderUserName || userName || null,
		originalSize,
		compressedSize,
		totalVolumes,
		receivedVolumes: new Set(),
		nextExpectedVolume: 0,
		volumeData: new Array(totalVolumes),
		status: 'receiving',
		originalHash,
		archiveHash,
		compression,
		fileCount,
		fileManifest,
		isArchive,
		transferMode,
		chunkSize,
		nackState: {
			requestSeq: 0,
			lastRequestedAt: 0
		},
		userName // 记录发送者名字
	};
	
	window.fileTransfers.set(fileId, fileTransfer);
	
	// 添加文件消息到聊天
	if (renderMessage && window.addOtherMsg) {
		let displayData;
		if (isArchive) {
			displayData = {
				type: 'file',
				fileId,
				fileName: `${fileCount} files`,
				originalSize,
				totalVolumes,
				fileCount,
				isArchive: true,
				userName
			};
		} else {
			displayData = {
				type: 'file',
				fileId,
				fileName,
				originalSize,
				totalVolumes,
				userName
			};
		}
		
		window.addOtherMsg(displayData, userName, userName, false, isPrivate ? 'file_private' : 'file');
	}
}

// Handle file volume message
// 处理文件分卷消息
function handleFileVolume(message, options = {}) {
	const { fileId, volumeIndex, volumeData } = message;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!isValidFileVolumeMessage(message, transfer)) return;
	
	transfer.receivedVolumes.add(volumeIndex);
	transfer.volumeData[volumeIndex] = volumeData;
	transfer.lastActivityAt = Date.now();
	refreshRepairFailureCheckOnVolume(transfer, message);
	requestGapRepairIfNeeded(transfer, volumeIndex, options);
	completeFileTransferIfReady(transfer);
	scheduleMissingChunkCheck(transfer, options);
	
	updateFileProgress(fileId);
}

// Handle file complete message
// 处理文件完成消息
function handleFileComplete(message, options = {}) {
	const { fileId } = message;
	if (!isValidFileId(fileId)) return;
	const transfer = window.fileTransfers.get(fileId);
	
	if (!transfer) return;
	const completed = completeFileTransferIfReady(transfer);

	if (!completed) {
		void requestMissingFileVolumes(transfer, 'complete_missing', options)
	}
	updateFileProgress(fileId);
}

function completeFileTransferIfReady(transfer) {
	const hasAllVolumeData = !Array.isArray(transfer?.volumeData) ||
		transfer.volumeData.length === transfer.totalVolumes && transfer.volumeData.every(volume => typeof volume === 'string');
	if (transfer && transfer.receivedVolumes.size === transfer.totalVolumes && hasAllVolumeData) {
		transfer.status = 'completed';
		transfer.repairStatus = 'completed';
		if (transfer.repairTimer) {
			clearTimeout(transfer.repairTimer);
			transfer.repairTimer = null
		}
		if (transfer.repairFailureTimer) {
			clearTimeout(transfer.repairFailureTimer);
			transfer.repairFailureTimer = null
		}
		scheduleCompletedTransferCleanup(transfer.fileId)
		return true
	}
	return false
}

function scheduleMissingChunkCheck(transfer, options = {}) {
	if (!transfer || transfer.direction !== 'receive' || transfer.compression !== 'none' || transfer.status === 'completed') {
		return
	}
	if (transfer.repairTimer) {
		clearTimeout(transfer.repairTimer)
	}
	transfer.repairTimer = setTimeout(() => {
		transfer.repairTimer = null;
		if (transfer.status === 'completed') return;
		void requestMissingFileVolumes(transfer, 'idle_timeout', options)
	}, MISSING_CHUNK_NACK_DELAY_MS)
}

function refreshRepairFailureCheckOnVolume(transfer, message) {
	if (!transfer || transfer.status === 'completed' || !transfer.nackState || !transfer.nackState.requestSeq) {
		return
	}
	const repairHasProgress = message && message.resent === true;
	const repairIsActive = transfer.repairStatus === 'requesting' ||
		transfer.repairStatus === 'waiting' ||
		transfer.repairStatus === 'failed';
	if (!repairHasProgress && !repairIsActive) {
		return
	}
	if (transfer.repairStatus === 'failed') {
		transfer.repairStatus = 'waiting'
	}
	scheduleRepairFailureCheck(transfer, transfer.nackState.requestSeq, transfer.repairTimeoutMs)
}

function scheduleRepairFailureCheck(transfer, requestSeq, timeoutMs = null) {
	if (!transfer || transfer.direction !== 'receive') return;
	if (transfer.repairFailureTimer) {
		clearTimeout(transfer.repairFailureTimer)
	}
	const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ?
		timeoutMs :
		getRepairResponseTimeoutMs(transfer);
	transfer.repairTimeoutMs = effectiveTimeoutMs;
	transfer.repairFailureTimer = setTimeout(() => {
		transfer.repairFailureTimer = null;
		if (
			transfer.status !== 'completed' &&
			transfer.nackState &&
			transfer.nackState.requestSeq === requestSeq &&
			(transfer.repairStatus === 'waiting' || transfer.repairStatus === 'requesting')
		) {
			transfer.repairStatus = 'failed';
			updateFileProgress(transfer.fileId)
		}
	}, effectiveTimeoutMs)
}

// Ask the original sender to privately resend missing direct-transfer chunks.
function requestMissingFileVolumes(transfer, reason, options = {}, requestedRanges = null) {
	if (!transfer || transfer.direction !== 'receive' || transfer.compression !== 'none') {
		return
	}
	if (!transfer.senderClientId || typeof options.sendClientMessage !== 'function') {
		transfer.repairStatus = 'failed';
		updateFileProgress(transfer.fileId);
		return
	}

	const missingRanges = requestedRanges || getMissingRanges(transfer);
	if (missingRanges.length === 0) {
		return
	}

	if (!transfer.nackState) {
		transfer.nackState = { requestSeq: 0, lastRequestedAt: 0 }
	}
	const missingKey = JSON.stringify(missingRanges);
	if (!options.forceRepairRequest && transfer.nackState.lastMissingKey === missingKey && Date.now() - transfer.nackState.lastRequestedAt < MISSING_CHUNK_NACK_DELAY_MS) {
		return
	}
	const repairTimeoutMs = getRepairResponseTimeoutMs(transfer, missingRanges);
	transfer.nackState.requestSeq += 1;
	transfer.nackState.lastRequestedAt = Date.now();
	transfer.nackState.lastMissingKey = missingKey;
	transfer.repairTimeoutMs = repairTimeoutMs;
	transfer.repairStatus = 'requesting';
	updateFileProgress(transfer.fileId);

	try {
		const requestSeq = transfer.nackState.requestSeq;
		const sendResult = options.sendClientMessage(transfer.senderClientId, 'file_nack', {
			type: 'file_nack',
			fileId: transfer.fileId,
			scope: transfer.scope || 'public',
			requestSeq: transfer.nackState.requestSeq,
			receivedCount: transfer.receivedVolumes.size,
			totalVolumes: transfer.totalVolumes,
			missingRanges,
			reason,
			ts: transfer.nackState.lastRequestedAt
		});
		Promise.resolve(sendResult)
			.then((sent) => {
				const waitingForReconnect = !sent &&
					typeof options.isConnectionOpen === 'function' &&
					!options.isConnectionOpen();
				transfer.repairStatus = sent || waitingForReconnect ? 'waiting' : 'failed';
				updateFileProgress(transfer.fileId);
				if (sent || waitingForReconnect) {
					const timeoutMs = waitingForReconnect ?
						Math.max(repairTimeoutMs, REPAIR_RECONNECT_GRACE_TIMEOUT_MS) :
						repairTimeoutMs;
					scheduleRepairFailureCheck(transfer, requestSeq, timeoutMs)
				}
			})
			.catch((error) => {
				const waitingForReconnect = typeof options.isConnectionOpen === 'function' && !options.isConnectionOpen();
				transfer.repairStatus = waitingForReconnect ? 'waiting' : 'failed';
				updateFileProgress(transfer.fileId);
				if (waitingForReconnect) {
					scheduleRepairFailureCheck(transfer, requestSeq, Math.max(repairTimeoutMs, REPAIR_RECONNECT_GRACE_TIMEOUT_MS))
				}
				console.error('File NACK request failed:', error)
			})
	} catch (error) {
		transfer.repairStatus = 'failed';
		updateFileProgress(transfer.fileId);
		console.error('File NACK request failed:', error)
	}
}

export function resumePendingFileRepairs(options = {}) {
	const { roomIndex, clientId, userName } = options;
	if (!clientId || !userName || !window.fileTransfers) return;
	for (const transfer of window.fileTransfers.values()) {
		if (!transfer || (roomIndex !== undefined && transfer.roomIndex !== undefined && transfer.roomIndex !== roomIndex)) {
			continue
		}
		if (transfer.direction === 'receive' && transfer.senderUserName === userName) {
			transfer.senderClientId = clientId;
			if (transfer.status !== 'completed' && transfer.compression === 'none' && getMissingRanges(transfer).length > 0) {
				requestMissingFileVolumes(transfer, 'reconnect', {
					...options,
					forceRepairRequest: true
				})
			}
		}
		if (transfer.direction === 'send' && transfer.scope === 'private' && transfer.targetClientName === userName) {
			transfer.targetClientId = clientId
		}
	}
}

async function handleFileNack(message, options = {}) {
	const requesterClientId = options.senderClientId;
	if (!requesterClientId || typeof options.sendClientMessage !== 'function') {
		return
	}
	if (!message || !isValidFileId(message.fileId)) {
		return
	}
	const transfer = window.fileTransfers.get(message.fileId);
	if (!canRepairDirectTransfer(transfer)) {
		return
	}
	if (transfer.roomIndex !== undefined && options.roomIndex !== undefined && transfer.roomIndex !== options.roomIndex) {
		return
	}
	if (transfer.scope === 'private' && transfer.targetClientId && transfer.targetClientId !== requesterClientId) {
		if (transfer.targetClientName && options.senderUserName === transfer.targetClientName && options.senderUserNameIsUnique === true) {
			transfer.targetClientId = requesterClientId
		} else {
			return
		}
	}
	if (message.totalVolumes !== undefined && message.totalVolumes !== transfer.totalVolumes) {
		return
	}
	const missingRanges = normalizeMissingRanges(message.missingRanges, transfer.totalVolumes);
	if (missingRanges.length === 0) {
		return
	}

	if (!transfer.resendInProgressByClient) {
		transfer.resendInProgressByClient = new Set()
	}
	if (transfer.resendInProgressByClient.has(requesterClientId)) {
		return
	}

	transfer.resendInProgressByClient.add(requesterClientId);
	try {
		for (const [start, end] of missingRanges) {
			for (let index = start; index <= end; index++) {
				const offset = index * transfer.chunkSize;
				const limit = Math.min(offset + transfer.chunkSize, transfer.sourceFile.size);
				const volume = await readFileSliceAsUint8Array(transfer.sourceFile, offset, limit);
				const sent = await options.sendClientMessage(requesterClientId, 'file_volume', {
					type: 'file_volume',
					fileId: transfer.fileId,
					volumeIndex: index,
					volumeData: arrayBufferToBase64(volume),
					isLast: index === transfer.totalVolumes - 1,
					resent: true
				});
				if (!sent) {
					return
				}
				transfer.resentVolumes = (transfer.resentVolumes || 0) + 1;
				if (transfer.resentVolumes % 4 === 0) {
					await yieldToBrowser()
				}
			}
		}
		await options.sendClientMessage(requesterClientId, 'file_complete', {
			type: 'file_complete',
			fileId: transfer.fileId,
			totalVolumes: transfer.totalVolumes,
			resent: true
		})
	} catch (error) {
		console.error('File NACK resend failed:', error)
	} finally {
		transfer.resendInProgressByClient.delete(requesterClientId)
	}
}

// Download file from volumes
export async function downloadFile(fileId) {
	const transfer = window.fileTransfers.get(fileId);
	if (!transfer) {
		if (window.addSystemMsg) {
			window.addSystemMsg(t('system.file_unavailable', 'File data is not available. Ask the sender to resend it.'));
		}
		return
	}
	if (transfer.status !== 'completed') {
		if (window.addSystemMsg) {
			window.addSystemMsg(t('system.file_not_ready', 'File is still being received. Please try again later.'));
		}
		return
	}
	
	try {
		if (transfer.isArchive) {
			// Download archive as multiple files
			await decompressArchiveToFiles(transfer.volumeData, transfer.fileManifest, transfer.archiveHash);
			// 删除系统提示
		} else if (transfer.compression === 'none') {
			await downloadRawVolumesToFile(transfer.volumeData, transfer.fileName, transfer.originalHash);
		} else {
			// Download single file
			await decompressVolumesToFile(transfer.volumeData, transfer.fileName, transfer.originalHash);
			// 删除系统提示
		}
		if (transfer.cleanupTimer) {
			clearTimeout(transfer.cleanupTimer);
		}
		window.fileTransfers.delete(fileId);
	} catch (error) {
		console.error('Download error:', error);
		window.addSystemMsg(`Failed to download: ${error.message}`);
	}
}

// Format file size
// 格式化文件大小
export function formatFileSize(bytes) {
	if (bytes === 0) return '0 Bytes';
	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
