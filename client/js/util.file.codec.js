// Pure file codec helpers: compression, archive packing, base64/volume encoding and validation (no DOM/window access)
// 纯文件编解码工具：压缩、归档打包、base64/分卷编解码与校验（不访问 DOM/window）
import { deflate } from 'fflate';
import { base64ToBytes, bytesToBase64 } from './util.serverCrypto.js';

// 分卷大小统一配置
export const DEFAULT_VOLUME_SIZE = 256 * 1024; // 256KB
export const MIN_VOLUME_SIZE = 32 * 1024;
export const MAX_FILE_VOLUMES = 32768;
const MAX_VOLUME_DATA_LENGTH = Math.ceil(DEFAULT_VOLUME_SIZE / 3) * 4 + 1024;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_FILE_COUNT = 200;
const DIRECT_TRANSFER_THRESHOLD = 8 * 1024 * 1024;
// Direct-mode receivers stream volumes to OPFS disk staging, so the cap is no longer
// bound by memory. Receivers without OPFS guard themselves at MEMORY_RECEIVE_LIMIT.
// 直传接收端经 OPFS 流式落盘，上限不再受内存约束；无 OPFS 的接收端以 MEMORY_RECEIVE_LIMIT 自我保护。
const MAX_SINGLE_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
export const MEMORY_RECEIVE_LIMIT = 200 * 1024 * 1024; // 内存接收路径的安全上限 / safe cap for the in-memory receive path
const FAST_DEFLATE_LEVEL = 3;
const PUBLIC_PAYLOAD_SAFETY_FACTOR = 3;
const FILE_ID_PATTERN = /^file_[a-f0-9-]{16,80}$/i;
const DIRECT_TRANSFER_EXTENSIONS = new Set([
	'7z', 'avi', 'br', 'bz2', 'gif', 'gz', 'heic', 'jpeg', 'jpg', 'm4a', 'm4v',
	'mkv', 'mov', 'mp3', 'mp4', 'ogg', 'png', 'rar', 'webm', 'webp', 'xz', 'zip'
]);

// Base64 encoding for binary data (more efficient than hex)
// Base64编码用于二进制数据（比十六进制更高效）
// Delegates to the shared codec (native toBase64 fast path with chunked btoa fallback);
// passes Uint8Array views through without the former defensive copy.
// 委托给共享编解码器（原生 toBase64 快路径 + 分块 btoa 后备）；Uint8Array 视图直接透传，不再做防御性拷贝。
export function arrayBufferToBase64(buffer) {
	const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
	return bytesToBase64(uint8Array);
}

// Base64 decoding back to binary
// Base64解码回二进制数据
export function base64ToArrayBuffer(base64) {
	return base64ToBytes(base64);
}

// Generate unique file ID
// 生成唯一文件ID
export function generateFileId() {
	if (crypto.randomUUID) {
		return `file_${crypto.randomUUID()}`
	}

	const randomBytes = crypto.getRandomValues(new Uint8Array(16));
	return 'file_' + Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Calculate SHA-256 hash for data integrity verification
// 计算SHA-256哈希值用于数据完整性验证
export async function calculateHash(data) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}



// Compress file into volumes with optimized compression
// 将文件压缩为分卷，优化压缩算法
export async function compressFileToVolumes(file, volumeSize = DEFAULT_VOLUME_SIZE) { // 96KB原始数据，base64后约128KB
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
					
					// Split compressed data into volumes (subarray views: encoded immediately, no copy needed)
					// 将压缩数据切分为分卷（subarray 视图：随即编码，无需拷贝）
					const volumes = [];
					for (let i = 0; i < compressed.length; i += volumeSize) {
						const volume = compressed.subarray(i, i + volumeSize);
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
export async function compressFilesToArchive(files, volumeSize = DEFAULT_VOLUME_SIZE) {	try {
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
				
				// Split compressed data into volumes (subarray views: encoded immediately, no copy needed)
				// 将压缩数据切分为分卷（subarray 视图：随即编码，无需拷贝）
				const volumes = [];
				for (let i = 0; i < compressed.length; i += volumeSize) {
					const volume = compressed.subarray(i, i + volumeSize);
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

export function shouldUseDirectTransfer(file) {
	return file.size > 0 && (file.size >= DIRECT_TRANSFER_THRESHOLD || DIRECT_TRANSFER_EXTENSIONS.has(getFileExtension(file.name)))
}

function alignVolumeSize(size) {
	return Math.max(MIN_VOLUME_SIZE, Math.min(DEFAULT_VOLUME_SIZE, Math.floor(size / MIN_VOLUME_SIZE) * MIN_VOLUME_SIZE || MIN_VOLUME_SIZE))
}

export function chooseVolumeSize(recipientCount = 1) {
	const recipients = Math.max(1, Number.isFinite(recipientCount) ? recipientCount : 1);
	const budgetPerRecipient = Math.floor((8 * 1024 * 1024) / (recipients * PUBLIC_PAYLOAD_SAFETY_FACTOR));
	return alignVolumeSize(budgetPerRecipient)
}

export function countVolumes(byteLength, volumeSize) {
	return Math.max(1, Math.ceil(byteLength / volumeSize))
}

export async function readFileSliceAsUint8Array(file, start, end) {
	return new Uint8Array(await file.slice(start, end).arrayBuffer())
}

export function yieldToBrowser() {
	return new Promise(resolve => setTimeout(resolve, 0))
}

function readFileAsArrayBuffer(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = (e) => resolve(e.target.result);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

export function combineVolumeData(volumes) {
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

export function isSafeIntegerInRange(value, min, max) {
	return Number.isSafeInteger(value) && value >= min && value <= max
}

export function isValidFileId(fileId) {
	return typeof fileId === 'string' && FILE_ID_PATTERN.test(fileId)
}

function isValidOptionalHash(value) {
	return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 128)
}

export function isValidFileStartMessage(message) {
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

export function isValidFileVolumeMessage(message, transfer) {
	if (!message || !transfer) return false;
	if (!isValidFileId(message.fileId)) return false;
	if (!isSafeIntegerInRange(message.volumeIndex, 0, transfer.totalVolumes - 1)) return false;
	if (typeof message.volumeData !== 'string' || message.volumeData.length === 0 || message.volumeData.length > MAX_VOLUME_DATA_LENGTH) return false;
	return !transfer.receivedVolumes.has(message.volumeIndex)
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

export function validateVolumeCount(volumes) {
	if (!Array.isArray(volumes) || !isSafeIntegerInRange(volumes.length, 1, MAX_FILE_VOLUMES)) {
		return `File is too large to transfer safely. Maximum is ${MAX_FILE_VOLUMES} chunks.`
	}
	return ''
}

export function validateVolumeTotal(totalVolumes) {
	if (!isSafeIntegerInRange(totalVolumes, 1, MAX_FILE_VOLUMES)) {
		return `File is too large to transfer safely. Maximum is ${MAX_FILE_VOLUMES} chunks.`
	}
	return ''
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
