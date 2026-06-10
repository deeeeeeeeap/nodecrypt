// Facade re-exporting the public file transfer API from the split util.file.* modules
// 门面模块：从拆分后的 util.file.* 模块再导出公共文件传输 API
export {
	formatFileSize,
	isSafeIntegerInRange,
	isValidFileId,
	validateSelectedFiles
} from './util.file.codec.js';
export {
	getMissingRanges,
	normalizeMissingRanges,
	resumePendingFileRepairs
} from './util.file.repair.js';
export { getFileTransferPresentation } from './util.file.view.js';
export {
	downloadFile,
	handleFileMessage,
	setupFileSend
} from './util.file.transfer.js';
export { fileTransfers } from './util.file.state.js';
