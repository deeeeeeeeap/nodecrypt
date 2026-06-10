export const HISTORY_KEY_PREFIX = 'nodecrypt-history-v1';

export function getHistoryKeySeed(credentials) {
	if (!credentials || typeof credentials.channel !== 'string' || typeof credentials.password !== 'string') {
		return ''
	}
	return `${HISTORY_KEY_PREFIX}|${credentials.channel}|${credentials.password}`
}

export function canUseTemporaryHistory(credentials) {
	return getHistoryKeySeed(credentials).length > 0
}
