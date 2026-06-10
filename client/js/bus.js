// Minimal synchronous event bus decoupling room logic from chat/ui rendering
// 极简同步事件总线，用于解耦房间逻辑与聊天/界面渲染
const listeners = new Map();

export function on(event, handler) {
	if (!listeners.has(event)) {
		listeners.set(event, new Set())
	}
	listeners.get(event).add(handler)
}

export function off(event, handler) {
	const handlers = listeners.get(event);
	if (handlers) {
		handlers.delete(handler)
	}
}

export function emit(event, ...args) {
	const handlers = listeners.get(event);
	if (!handlers) return;
	for (const handler of [...handlers]) {
		handler(...args)
	}
}
