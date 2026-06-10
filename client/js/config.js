// Global client configuration (formerly window.config defined in main.js)
// 全局客户端配置（原先由 main.js 挂载的 window.config）
export const config = {
	wsAddress: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`, // WebSocket 服务器地址 / WebSocket server address
	// wsAddress: `wss://your-worker.example.com`,
	debug: false // 是否开启调试模式 / Enable debug mode
};
