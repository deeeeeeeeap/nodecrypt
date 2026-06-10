// File upload modal and batch processing utilities
// 文件上传模态框和批量处理工具

import {
	$,
	$id,
	createElement,
	on,
	addClass,
	removeClass
} from './util.dom.js';
import { formatFileSize, validateSelectedFiles } from './util.file.codec.js';
import { t } from './util.i18n.js';
import { escapeHTML } from './util.string.js';
import { emit } from './bus.js';

// File upload modal state
// 文件上传模态框状态
let uploadModal = null;
let selectedFiles = new Map();
let fileIdCounter = 0;
let onSendCallback = null;
let documentDragGuardsInstalled = false;

function handleBrowseClick() {
	const fileInput = $('#file-upload-input', uploadModal);
	if (fileInput) {
		fileInput.click()
	}
}

function preventDocumentDragWhenModalOpen(e) {
	if (uploadModal || Array.from(e.dataTransfer?.types || []).includes('Files')) {
		e.preventDefault()
	}
}

function ensureDocumentDragGuards() {
	if (documentDragGuardsInstalled) return;
	on(document, 'dragover', preventDocumentDragWhenModalOpen);
	on(document, 'drop', preventDocumentDragWhenModalOpen);
	documentDragGuardsInstalled = true
}

// Listen for language changes to update modal text
// 监听语言变更以更新模态框文本
if (typeof window !== 'undefined') {
	window.addEventListener('languageChange', () => {
		if (uploadModal) {
			updateModalTexts();
		}
	});
}

// Update modal texts when language changes
// 语言切换时更新模态框文本
function updateModalTexts() {
	if (!uploadModal) return;
	
	// Update modal title
	const modalTitle = uploadModal.querySelector('.file-upload-header h3');
	if (modalTitle) {
		modalTitle.textContent = t('file.upload_files', 'Upload Files');
	}
	
	// Update file list title
	const fileListTitle = uploadModal.querySelector('.file-list-title');
	if (fileListTitle) {
		fileListTitle.textContent = t('file.selected_files', 'Selected Files');
	}
	
	// Update clear all button
	const clearAllBtn = uploadModal.querySelector('.file-clear-all-btn');
	if (clearAllBtn) {
		clearAllBtn.textContent = t('file.clear_all', 'Clear All');
	}
	
	// Update cancel button
	const cancelBtn = uploadModal.querySelector('.file-upload-cancel-btn');
	if (cancelBtn) {
		cancelBtn.textContent = t('file.cancel', 'Cancel');
	}
	
	// Update send files button
	const sendBtn = uploadModal.querySelector('.file-upload-send-btn');
	if (sendBtn) {
		sendBtn.textContent = t('file.send_files', 'Send Files');
	}
	
	// Update drag drop text
	const dragDropText = uploadModal.querySelector('.file-drop-text');
	if (dragDropText) {
		dragDropText.innerHTML = `
			<p><strong>${t('file.drag_drop', 'Drag and drop files here')}</strong></p>
			<p>${t('file.or', 'or')} <button class="file-browse-btn" type="button">${t('file.browse_files', 'browse files')}</button></p>
		`;
		
		// Re-attach browse button event
		const browseBtn = dragDropText.querySelector('.file-browse-btn');
		if (browseBtn) {
			on(browseBtn, 'click', handleBrowseClick);
		}
	}
	
	// Update summary if files are selected
	if (selectedFiles.size > 0) {
		updateFileList();
		updateSendButton();
	}
}

// Generate unique file ID
// 生成唯一文件ID
function generateFileId() {
	if (crypto.randomUUID) {
		return `upload_${crypto.randomUUID()}`
	}

	const randomBytes = crypto.getRandomValues(new Uint8Array(16));
	return 'upload_' + Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Create file upload modal
// 创建文件上传模态框
function createUploadModal() {
	const modal = createElement('div', {
		class: 'file-upload-modal'
	}, `
		<div class="file-upload-overlay"></div>		<div class="file-upload-container">
			<div class="file-upload-header">
				<h3>${t('file.upload_files', 'Upload Files')}</h3>
				<button class="file-upload-close">&times;</button>
			</div>
			<div class="file-upload-content">				<div class="file-drop-zone" id="file-drop-zone">
					<div class="file-drop-icon">📁</div>
					<div class="file-drop-text">
						<p><strong>${t('file.drag_drop', 'Drag and drop files here')}</strong></p>
						<p>${t('file.or', 'or')} <button class="file-browse-btn" type="button">${t('file.browse_files', 'browse files')}</button></p>
					</div>
					<input type="file" id="file-upload-input" multiple style="display: none;" accept="*/*">
				</div>
				<div class="file-list-container" id="file-list-container" style="display: none;">
					<div class="file-list-header">
						<span class="file-list-title">${t('file.selected_files', 'Selected Files')}</span>
						<button class="file-clear-all-btn" type="button">${t('file.clear_all', 'Clear All')}</button>
					</div>
					<div class="file-list" id="file-list"></div>
					<div class="file-list-summary" id="file-list-summary"></div>
					<div class="file-list-error" id="file-list-error" role="alert"></div>
				</div>
			</div>
			<div class="file-upload-footer">
				<button class="file-upload-cancel-btn" type="button">${t('file.cancel', 'Cancel')}</button>
				<button class="file-upload-send-btn" type="button" disabled>${t('file.send_files', 'Send Files')}</button>
			</div>
		</div>
	`);

	return modal;
}

// Show file upload modal
// 显示文件上传模态框
export function showFileUploadModal(onSend) {
	if (uploadModal) {
		document.body.removeChild(uploadModal);
	}

	onSendCallback = onSend;
	selectedFiles.clear();
	
	uploadModal = createUploadModal();
	document.body.appendChild(uploadModal);
	
	setupModalEvents();
	
	// Focus and animation
	setTimeout(() => {
		addClass(uploadModal, 'show');
	}, 10);
}

// Hide file upload modal
// 隐藏文件上传模态框
function hideUploadModal() {
	if (!uploadModal) return;
	const modalToHide = uploadModal;
	
	removeClass(modalToHide, 'show');
	setTimeout(() => {
		if (modalToHide.parentNode) {
			document.body.removeChild(modalToHide);
		}
		if (uploadModal !== modalToHide) return;
		uploadModal = null;
		selectedFiles.clear();
		onSendCallback = null;
		
		// 通知主模块重置拖拽标志位
		window.dispatchEvent(new CustomEvent('fileUploadModalClosed'));
	}, 300);
}

// Setup modal event listeners
// 设置模态框事件监听器
function setupModalEvents() {
	if (!uploadModal) return;

	const overlay = $('.file-upload-overlay', uploadModal);
	const closeBtn = $('.file-upload-close', uploadModal);
	const cancelBtn = $('.file-upload-cancel-btn', uploadModal);
	const sendBtn = $('.file-upload-send-btn', uploadModal);
	const browseBtn = $('.file-browse-btn', uploadModal);
	const fileInput = $('#file-upload-input', uploadModal);
	const dropZone = $('#file-drop-zone', uploadModal);
	const clearAllBtn = $('.file-clear-all-btn', uploadModal);

	// Close modal events
	on(overlay, 'click', hideUploadModal);
	on(closeBtn, 'click', hideUploadModal);
	on(cancelBtn, 'click', hideUploadModal);

	// Browse files
	on(browseBtn, 'click', handleBrowseClick);
	on(fileInput, 'change', handleFileInputChange);

	// Drag and drop
	on(dropZone, 'dragover', handleDragOver);
	on(dropZone, 'dragleave', handleDragLeave);
	on(dropZone, 'drop', handleDrop);

	// Clear all files
	on(clearAllBtn, 'click', clearAllFiles);

	// Send files
	on(sendBtn, 'click', handleSendFiles);

	ensureDocumentDragGuards();
}

// Handle file input change
// 处理文件输入变化
function handleFileInputChange(e) {
	const files = Array.from(e.target.files);
	addFiles(files);
	e.target.value = ''; // Clear input
}

// Handle drag over
// 处理拖拽悬停
function handleDragOver(e) {
	e.preventDefault();
	e.stopPropagation();
	addClass(e.currentTarget, 'drag-over');
}

// Handle drag leave
// 处理拖拽离开
function handleDragLeave(e) {
	e.preventDefault();
	e.stopPropagation();
	removeClass(e.currentTarget, 'drag-over');
}

// Handle drop
// 处理文件拖放
function handleDrop(e) {
	e.preventDefault();
	e.stopPropagation();
	removeClass(e.currentTarget, 'drag-over');
	
	const files = Array.from(e.dataTransfer.files);
	addFiles(files);
}

// Add files to selection
// 添加文件到选择列表
function addFiles(files) {
	files.forEach(file => {
		const fileId = generateFileId();
		selectedFiles.set(fileId, file);
	});
	
	updateFileList();
	updateSendButton();
}

// Remove file from selection
// 从选择列表中移除文件
function removeFile(fileId) {
	selectedFiles.delete(fileId);
	updateFileList();
	updateSendButton();
}

// Clear all files
// 清空所有文件
function clearAllFiles() {
	selectedFiles.clear();
	updateFileList();
	updateSendButton();
}

function getSelectedFilesArray() {
	return Array.from(selectedFiles.values())
}

function getSelectionError() {
	return validateSelectedFiles(getSelectedFilesArray())
}

// Update file list display
// 更新文件列表显示
function updateFileList() {
	if (!uploadModal) return;

	const fileList = $('#file-list', uploadModal);
	const fileListContainer = $('#file-list-container', uploadModal);
	const fileListSummary = $('#file-list-summary', uploadModal);
	const fileListError = $('#file-list-error', uploadModal);
	const dropZone = $('#file-drop-zone', uploadModal);

	if (selectedFiles.size === 0) {
		fileListContainer.style.display = 'none';
		dropZone.style.display = 'flex';
		if (fileListError) {
			fileListError.textContent = '';
			fileListError.style.display = 'none'
		}
		return;
	}

	fileListContainer.style.display = 'block';
	dropZone.style.display = 'none';

	// Update file list
	fileList.innerHTML = '';
	
	for (const [fileId, file] of selectedFiles) {
		const safeFileName = escapeHTML(file.name);
		const fileItem = createElement('div', {
			class: 'file-item',
			'data-file-id': fileId
		}, `
			<div class="file-item-info">
				<div class="file-item-name" title="${safeFileName}">${safeFileName}</div>
				<div class="file-item-size">${formatFileSize(file.size)}</div>
			</div>
			<button class="file-item-remove" type="button" data-file-id="${fileId}">&times;</button>
		`);
		
		fileList.appendChild(fileItem);
		
		// Add remove event
		const removeBtn = $('.file-item-remove', fileItem);
		on(removeBtn, 'click', (e) => {
			e.preventDefault();
			removeFile(fileId);
		});
	}	// Update summary
	const totalSize = Array.from(selectedFiles.values()).reduce((sum, file) => sum + file.size, 0);
	const summaryText = t('file.files_selected', '{count} files selected, {size} total')
		.replace('{count}', selectedFiles.size)
		.replace('{size}', formatFileSize(totalSize));
	fileListSummary.textContent = summaryText;
	const selectionError = getSelectionError();
	if (fileListError) {
		fileListError.textContent = selectionError;
		fileListError.style.display = selectionError ? 'block' : 'none'
	}
}

// Update send button state
// 更新发送按钮状态
function updateSendButton() {
	if (!uploadModal) return;

	const sendBtn = $('.file-upload-send-btn', uploadModal);
	if (sendBtn) {
		sendBtn.disabled = selectedFiles.size === 0 || Boolean(getSelectionError())
	}
}

// Handle send files
// 处理发送文件
async function handleSendFiles() {
	if (selectedFiles.size === 0 || !onSendCallback) return;

	const selectionError = getSelectionError();
	if (selectionError) {
		updateFileList();
		updateSendButton();
		return
	}

	const files = getSelectedFilesArray();
	const sendCallback = onSendCallback;
	const sendBtn = $('.file-upload-send-btn', uploadModal);
	
	try {
		if (sendBtn) {
			sendBtn.disabled = true;
			sendBtn.textContent = t('file.preparing', 'Preparing...');
		}
		emit('chat:add-system-msg', t('system.file_prepare', 'Preparing file transfer...'));

		// Close modal first
		hideUploadModal();
		
		// Send files through callback
		await sendCallback(files);
		
	} catch (error) {
		console.error('Error sending files:', error);
		emit('chat:add-system-msg', `${t('system.file_send_failed', 'Failed to send files:')} ${error.message}`);
		if (uploadModal && sendBtn) {
			sendBtn.disabled = false;
			sendBtn.textContent = t('file.send_files', 'Send Files')
		}
	}
}

// Handle keyboard events
// 处理键盘事件
if (typeof document !== 'undefined') {
	on(document, 'keydown', (e) => {
		if (!uploadModal) return;
		
		if (e.key === 'Escape') {
			hideUploadModal();
		}
	});
}
