// File transfer DOM presentation: progress bars and status rendering
// 文件传输的 DOM 展示：进度条与状态渲染
import { fileTransfers } from './util.file.state.js';

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

export function getFileTransferPresentation(fileId, isSender = false) {
	const transfer = fileTransfers.get(fileId);
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

// Update file progress in chat
// 更新聊天中的文件进度
export function updateFileProgress(fileId, immediate = false) {
	if (!immediate && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
		if (fileProgressFrames.has(fileId)) return;
		const frame = window.requestAnimationFrame(() => {
			fileProgressFrames.delete(fileId);
			updateFileProgress(fileId, true)
		});
		fileProgressFrames.set(fileId, frame);
		return
	}
	const transfer = fileTransfers.get(fileId);
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
