export const CHAT_RENDER_MESSAGE_LIMIT = 300;
export const SCROLL_BOTTOM_THRESHOLD = 80;

export function getRecentMessages(messages, limit = CHAT_RENDER_MESSAGE_LIMIT) {
	if (!Array.isArray(messages)) return [];
	const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : CHAT_RENDER_MESSAGE_LIMIT;
	return messages.length > safeLimit ? messages.slice(-safeLimit) : messages.slice()
}

export function isNearBottomScroll(scrollHeight, scrollTop, clientHeight, threshold = SCROLL_BOTTOM_THRESHOLD) {
	const safeThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : SCROLL_BOTTOM_THRESHOLD;
	return Math.max(0, scrollHeight - scrollTop - clientHeight) <= safeThreshold
}
