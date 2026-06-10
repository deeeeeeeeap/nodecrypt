// OPFS-backed receive sink: streams decoded volumes of direct-mode transfers to
// origin-private disk storage, so large incoming files no longer pin ~1.33x their
// size as base64 strings in memory. Falls back transparently when OPFS is missing.
// 基于 OPFS 的接收落盘器：直传模式的分卷解码后流式写入源私有文件系统，
// 大文件接收不再以 base64 字符串（约 1.33 倍体积）驻留内存；OPFS 不可用时由调用方回退。
import { sha256 } from 'js-sha256';

const SINK_DIR_NAME = 'nodecrypt-transfers';
const HASH_READ_CHUNK = 8 * 1024 * 1024;

export function isOpfsSinkSupported() {
	try {
		return typeof navigator !== 'undefined' &&
			!!navigator.storage &&
			typeof navigator.storage.getDirectory === 'function' &&
			typeof FileSystemFileHandle !== 'undefined' &&
			typeof FileSystemFileHandle.prototype.createWritable === 'function'
	} catch {
		return false
	}
}

async function getSinkDirectory() {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(SINK_DIR_NAME, { create: true })
}

// Transfers never survive a reload (fileTransfers lives in memory), so any file left in
// the sink directory from a previous session is garbage; wipe them once at startup.
// 传输状态不跨刷新存活（fileTransfers 在内存中），上一会话残留的落盘文件均为孤儿，启动时清空。
export async function wipeOrphanedSinkFiles() {
	if (!isOpfsSinkSupported()) return;
	try {
		const dir = await getSinkDirectory();
		const names = [];
		for await (const name of dir.keys()) {
			names.push(name)
		}
		for (const name of names) {
			try {
				await dir.removeEntry(name, { recursive: true })
			} catch {}
		}
	} catch {}
}

// Volumes may arrive out of order (NACK repair); positioned writes zero-fill gaps per
// spec and later writes overwrite them. All writes funnel through one sequential queue
// so finalize() observes every enqueued write before closing.
// 分卷可能乱序到达（NACK 修复）；按位置写入时规范保证空洞补零、后续写覆盖。
// 全部写入经单一串行队列，finalize() 必然等到所有已入队写入完成后才关闭。
export async function createReceiveSink(fileId) {
	const dir = await getSinkDirectory();
	const handle = await dir.getFileHandle(fileId, { create: true });
	const writable = await handle.createWritable();
	let queue = Promise.resolve();
	let failure = null;
	let closed = false;

	return {
		writeVolume(position, bytes) {
			queue = queue.then(() => {
				if (failure || closed) return;
				return writable.write({ type: 'write', position, data: bytes })
			}).catch((error) => {
				if (!failure) failure = error
			});
			return queue.then(() => {
				if (failure) throw failure
			})
		},
		async finalize() {
			await queue.catch(() => {});
			if (failure) throw failure;
			if (!closed) {
				closed = true;
				await writable.close()
			}
			return handle.getFile()
		},
		async dispose() {
			const wasClosed = closed;
			closed = true;
			await queue.catch(() => {});
			if (!wasClosed) {
				try {
					await writable.abort()
				} catch {}
			}
			try {
				const sinkDir = await getSinkDirectory();
				await sinkDir.removeEntry(fileId)
			} catch {}
		}
	}
}

// Incremental hash over sliced reads: peak memory stays at one read chunk regardless of
// file size (crypto.subtle.digest would need the entire file in memory at once).
// 分片增量哈希：峰值内存恒为单个读取块，与文件大小无关
// （crypto.subtle.digest 需要整个文件一次性驻留内存）。
export async function verifyFileHash(file, expectedHex) {
	const hash = sha256.create();
	for (let offset = 0; offset < file.size; offset += HASH_READ_CHUNK) {
		const chunk = await file.slice(offset, offset + HASH_READ_CHUNK).arrayBuffer();
		hash.update(new Uint8Array(chunk))
	}
	return hash.hex() === expectedHex
}
