import test from 'node:test';
import assert from 'node:assert/strict';

import {
	HISTORY_KEY_PREFIX,
	canUseTemporaryHistory,
	getHistoryKeySeed
} from '../../client/js/history.logic.js';

test('temporary history key seed does not require a non-empty room password', () => {
	const emptyPasswordCredentials = {
		channel: 'c'.repeat(64),
		password: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		hasPassword: false
	};

	assert.equal(canUseTemporaryHistory(emptyPasswordCredentials), true);
	assert.equal(
		getHistoryKeySeed(emptyPasswordCredentials),
		`${HISTORY_KEY_PREFIX}|${emptyPasswordCredentials.channel}|${emptyPasswordCredentials.password}`
	);
});

test('temporary history key seed rejects missing credentials', () => {
	assert.equal(canUseTemporaryHistory(null), false);
	assert.equal(canUseTemporaryHistory({ channel: 'room' }), false);
	assert.equal(canUseTemporaryHistory({ password: 'pw' }), false);
});
