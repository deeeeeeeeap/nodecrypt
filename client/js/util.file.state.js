// Shared file transfer state map used by the util.file.* modules
// util.file.* 各模块共享的文件传输状态表

// File transfer state management
// 文件传输状态管理
export const fileTransfers = new Map();

// Expose the same Map on window as a test hook for the e2e smoke harness
// (scripts/cloudflare-smoke.mjs reads and mutates transfers through window.fileTransfers).
// 将同一个 Map 暴露到 window，作为端到端 smoke 脚本的测试钩子
// （scripts/cloudflare-smoke.mjs 通过 window.fileTransfers 读取并修改传输状态）。
if (typeof window !== 'undefined') {
	window.fileTransfers = fileTransfers
}
