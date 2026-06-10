// File transfer orchestration: send/receive state machine, TTL cleanup and download triggering
// 文件传输编排：发送/接收状态机、TTL 清理与下载触发
import { inflate } from 'fflate';
import { showFileUploadModal } from './util.fileUpload.js';
import { t } from './util.i18n.js';
import { emit } from './bus.js';
import { fileTransfers } from './util.file.state.js';
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	calculateHash,
	chooseVolumeSize,
	combineVolumeData,
	compressFileToVolumes,
	compressFilesToArchive,
	countVolumes,
	generateFileId,
	isSafeIntegerInRange,
	isValidFileId,
	isValidFileStartMessage,
	isValidFileVolumeMessage,
	readFileSliceAsUint8Array,
	shouldUseDirectTransfer,
	validateSelectedFiles,
	validateVolumeCount,
	validateVolumeTotal,
	yieldToBrowser,
	DEFAULT_VOLUME_SIZE,
	MEMORY_RECEIVE_LIMIT,
	MIN_VOLUME_SIZE
} from './util.file.codec.js';
import {
	createReceiveSink,
	isOpfsSinkSupported,
	verifyFileHash,
	wipeOrphanedSinkFiles
} from './util.file.sink.js';
import {
	handleFileNack,
	refreshRepairFailureCheckOnVolume,
	requestGapRepairIfNeeded,
	requestMissingFileVolumes,
	scheduleMissingChunkCheck
} from './util.file.repair.js';
import { updateFileProgress } from './util.file.view.js';

const MAX_ARCHIVE_FAST_PATH_SIZE = 64 * 1024 * 1024;
const COMPLETED_TRANSFER_TTL_MS = 60 * 60 * 1000;
const RESUMABLE_TRANSFER_TTL_MS = 10 * 60 * 1000;
const FILE_VOLUME_YIELD_INTERVAL = 4;
const STALE_RECEIVE_TTL_MS = 15 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 60 * 1000;
const SINK_DISPOSE_GRACE_MS = 5 * 60 * 1000;

// Incomplete inbound transfers whose sender stopped feeding volumes can never finish once
// the sender's repair window (RESUMABLE_TRANSFER_TTL_MS) lapses; sweep them so their
// volumeData does not pin up to hundreds of MB for the rest of the session. Late volumes
// for a swept fileId are rejected by isValidFileVolumeMessage (missing transfer).
// 发送方停止供给分卷的未完成接收任务,在对方修复窗口过期后已不可能完成;定期清掉,
// 避免 volumeData 在整个会话期间占住内存。被清理 fileId 的迟到分卷会因传输记录缺失
// 而被 isValidFileVolumeMessage 拒绝。
const staleReceiveSweepTimer = setInterval(() => {
	const now = Date.now();
	for (const [fileId, transfer] of fileTransfers) {
		if (!transfer || transfer.direction !== 'receive' || transfer.status === 'completed') continue;
		const lastActivityAt = transfer.lastActivityAt || 0;
		if (lastActivityAt && now - lastActivityAt > STALE_RECEIVE_TTL_MS) {
			if (transfer.repairTimer) clearTimeout(transfer.repairTimer);
			if (transfer.repairFailureTimer) clearTimeout(transfer.repairFailureTimer);
			if (transfer.cleanupTimer) clearTimeout(transfer.cleanupTimer);
			disposeTransferSink(transfer);
			fileTransfers.delete(fileId)
		}
	}
}, STALE_SWEEP_INTERVAL_MS);
// Under Node (fast tests import this module) the interval must not keep the process alive.
// Node 环境(快测会导入本模块)下不能让该定时器阻止进程退出。
if (staleReceiveSweepTimer && typeof staleReceiveSweepTimer.unref === 'function') {
	staleReceiveSweepTimer.unref()
}

// Sink files from previous sessions can never be claimed again; clear them on startup.
// 上一会话遗留的落盘文件不可能再被认领,启动时清理。
void wipeOrphanedSinkFiles();

function disposeTransferSink(transfer) {
	if (!transfer || !transfer.sinkPromise) return;
	const pending = transfer.sinkPromise;
	transfer.sinkPromise = null;
	void pending.then((sink) => sink.dispose()).catch(() => {})
}

function failSinkTransfer(fileId, error) {
	const transfer = fileTransfers.get(fileId);
	if (!transfer) return;
	console.error('File sink write failed:', error);
	emit('chat:add-system-msg', t('system.file_receive_failed', 'Failed to store the incoming file (out of disk space?). The transfer was cancelled.'));
	if (transfer.repairTimer) clearTimeout(transfer.repairTimer);
	if (transfer.repairFailureTimer) clearTimeout(transfer.repairFailureTimer);
	disposeTransferSink(transfer);
	fileTransfers.delete(fileId)
}

function enqueueSinkVolumeWrite(transfer, volumeIndex, volumeBase64) {
	const fileId = transfer.fileId;
	let bytes;
	try {
		// Decode eagerly so the base64 string is released right away.
		// 立即解码,尽早释放 base64 字符串。
		bytes = base64ToArrayBuffer(volumeBase64)
	} catch (error) {
		transfer.receivedVolumes.delete(volumeIndex);
		return
	}
	const position = volumeIndex * transfer.chunkSize;
	void transfer.sinkPromise
		.then((sink) => sink.writeVolume(position, bytes))
		.catch((error) => {
			const latest = fileTransfers.get(fileId);
			if (latest && latest.sinkPromise) {
				failSinkTransfer(fileId, error)
			}
		})
}

function scheduleCompletedTransferCleanup(fileId) {
	const transfer = fileTransfers.get(fileId);
	if (!transfer || transfer.cleanupTimer) return;
	transfer.cleanupTimer = setTimeout(() => {
		const latest = fileTransfers.get(fileId);
		if (latest && latest.status === 'completed') {
			disposeTransferSink(latest);
			fileTransfers.delete(fileId)
		}
	}, COMPLETED_TRANSFER_TTL_MS)
}

function scheduleSourceFileRelease(fileId) {
	const transfer = fileTransfers.get(fileId);
	if (!transfer || !transfer.sourceFile || transfer.sourceFileReleaseTimer) return;
	const releaseAfterMs = Math.max(0, (transfer.resumeUntil || Date.now()) - Date.now());
	transfer.sourceFileReleaseTimer = setTimeout(() => {
		const latest = fileTransfers.get(fileId);
		if (latest && latest.transferMode === 'direct') {
			latest.sourceFile = null;
			latest.sourceFileReleaseTimer = null
		}
	}, releaseAfterMs)
}

function refreshSourceFileRepairWindow(fileId) {
	const transfer = fileTransfers.get(fileId);
	if (!transfer || transfer.transferMode !== 'direct' || !transfer.sourceFile) return;
	transfer.resumeUntil = Date.now() + RESUMABLE_TRANSFER_TTL_MS;
	if (transfer.sourceFileReleaseTimer) {
		clearTimeout(transfer.sourceFileReleaseTimer);
		transfer.sourceFileReleaseTimer = null
	}
	scheduleSourceFileRelease(fileId)
}

function saveBlobAsFile(blob, fileName) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function saveUint8ArrayAsFile(data, fileName) {
	saveBlobAsFile(new Blob([data]), fileName);
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

function reportFileSendLimit(message) {
	emit('chat:add-system-msg', `Failed to send files: ${message}`)
}

async function sendDirectFileVolumes(fileId, file, volumeSize, totalVolumes, onSend, updateProgress) {
	const fileTransfer = fileTransfers.get(fileId);
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

		fileTransfers.set(fileId, fileTransfer);
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

	fileTransfers.set(fileId, fileTransfer);

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
			
			fileTransfers.set(fileId, fileTransfer);
			
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
		emit('chat:add-system-msg', `${t('system.file_send_failed', 'Failed to send files:')} ${error.message}`);
	}
}

// Send volumes with progress tracking
// 发送分卷并跟踪进度
async function sendVolumes(fileId, volumes, onSend, updateProgress, fileName) {
	const fileTransfer = fileTransfers.get(fileId);
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

	// Direct-mode volumes stream to OPFS disk staging when available; the in-memory
	// fallback self-protects against files it cannot safely hold as base64 strings.
	// 直传分卷优先经 OPFS 流式落盘;内存后备路径对无法安全驻留的大文件自我保护。
	const useSink = transferMode === 'direct' &&
		isOpfsSinkSupported() &&
		isSafeIntegerInRange(chunkSize, MIN_VOLUME_SIZE, DEFAULT_VOLUME_SIZE);
	if (transferMode === 'direct' && !useSink && originalSize > MEMORY_RECEIVE_LIMIT) {
		if (renderMessage) {
			emit('chat:add-system-msg', t('system.file_too_large_for_memory', 'An incoming file was skipped: it is too large to receive without disk staging (OPFS), which this browser does not support.'))
		}
		return
	}

	// A duplicate file_start replaces the transfer record; release the old sink file first.
	// 重复的 file_start 会重建传输记录,先释放旧的落盘文件。
	disposeTransferSink(fileTransfers.get(fileId));

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
		volumeData: useSink ? null : new Array(totalVolumes),
		sinkPromise: null,
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
		lastActivityAt: Date.now(),
		userName // 记录发送者名字
	};

	if (useSink) {
		fileTransfer.sinkPromise = createReceiveSink(fileId);
		fileTransfer.sinkPromise.catch((error) => {
			const latest = fileTransfers.get(fileId);
			if (latest && latest.sinkPromise) {
				failSinkTransfer(fileId, error)
			}
		})
	}

	fileTransfers.set(fileId, fileTransfer);
	
	// 添加文件消息到聊天
	if (renderMessage) {
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
		
		emit('chat:add-other-msg', displayData, userName, userName, false, isPrivate ? 'file_private' : 'file');
	}
}

// Handle file volume message
// 处理文件分卷消息
function handleFileVolume(message, options = {}) {
	const { fileId, volumeIndex, volumeData } = message;
	const transfer = fileTransfers.get(fileId);
	
	if (!isValidFileVolumeMessage(message, transfer)) return;
	
	transfer.receivedVolumes.add(volumeIndex);
	if (transfer.sinkPromise) {
		enqueueSinkVolumeWrite(transfer, volumeIndex, volumeData)
	} else {
		transfer.volumeData[volumeIndex] = volumeData
	}
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
	const transfer = fileTransfers.get(fileId);
	
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

// Download file from volumes
export async function downloadFile(fileId) {
	const transfer = fileTransfers.get(fileId);
	if (!transfer) {
		emit('chat:add-system-msg', t('system.file_unavailable', 'File data is not available. Ask the sender to resend it.'));
		return
	}
	if (transfer.status !== 'completed') {
		emit('chat:add-system-msg', t('system.file_not_ready', 'File is still being received. Please try again later.'));
		return
	}
	
	try {
		if (transfer.isArchive) {
			// Download archive as multiple files
			await decompressArchiveToFiles(transfer.volumeData, transfer.fileManifest, transfer.archiveHash);
			// 删除系统提示
		} else if (transfer.sinkPromise) {
			// Sink-backed direct transfer: hand the disk-staged File straight to the
			// download anchor; the browser streams it without a full in-memory copy.
			// 落盘直传:把磁盘暂存的 File 直接交给下载锚点,浏览器流式读出,无需整文件驻留内存。
			const sink = await transfer.sinkPromise;
			const stagedFile = await sink.finalize();
			if (transfer.originalHash && !(await verifyFileHash(stagedFile, transfer.originalHash))) {
				throw new Error('File integrity check failed: hash mismatch')
			}
			saveBlobAsFile(stagedFile, transfer.fileName);
			// Deleting the OPFS entry invalidates the File while the browser may still be
			// streaming the download from it; release it after a grace period instead.
			// 立即删除 OPFS 条目会使浏览器仍在流式保存的 File 失效;延迟一段宽限期再释放。
			const pendingSink = transfer.sinkPromise;
			transfer.sinkPromise = null;
			setTimeout(() => {
				void pendingSink.then((s) => s.dispose()).catch(() => {})
			}, SINK_DISPOSE_GRACE_MS)
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
		fileTransfers.delete(fileId);
	} catch (error) {
		console.error('Download error:', error);
		emit('chat:add-system-msg', `Failed to download: ${error.message}`);
	}
}
