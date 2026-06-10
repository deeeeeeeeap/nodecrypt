// NACK-based file repair: missing-range computation plus repair request/response handling
// 基于 NACK 的文件修复：缺块区间计算与修复请求/响应处理
import {
	DEFAULT_VOLUME_SIZE,
	MIN_VOLUME_SIZE,
	MAX_FILE_VOLUMES,
	arrayBufferToBase64,
	isSafeIntegerInRange,
	isValidFileId,
	readFileSliceAsUint8Array,
	yieldToBrowser
} from './util.file.codec.js';
import { fileTransfers } from './util.file.state.js';
import { updateFileProgress } from './util.file.view.js';

const MAX_NACK_RANGES = 64;
const MAX_NACK_CHUNKS_PER_REQUEST = 256;
const MISSING_CHUNK_NACK_DELAY_MS = 3000;
const MIN_REPAIR_RESPONSE_TIMEOUT_MS = 6000;
const MAX_REPAIR_RESPONSE_TIMEOUT_MS = 60000;
const REPAIR_RECONNECT_GRACE_TIMEOUT_MS = 15000;
const REPAIR_TIMEOUT_BYTES_PER_MS = 1024;

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

export function requestGapRepairIfNeeded(transfer, volumeIndex, options = {}) {
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

export function scheduleMissingChunkCheck(transfer, options = {}) {
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

export function refreshRepairFailureCheckOnVolume(transfer, message) {
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
export function requestMissingFileVolumes(transfer, reason, options = {}, requestedRanges = null) {
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
	if (!clientId || !userName || !fileTransfers) return;
	for (const transfer of fileTransfers.values()) {
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

export async function handleFileNack(message, options = {}) {
	const requesterClientId = options.senderClientId;
	if (!requesterClientId || typeof options.sendClientMessage !== 'function') {
		return
	}
	if (!message || !isValidFileId(message.fileId)) {
		return
	}
	const transfer = fileTransfers.get(message.fileId);
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
