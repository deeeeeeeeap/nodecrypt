import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getRecentMessages,
	isNearBottomScroll
} from '../../client/js/chat.logic.js';

test('getRecentMessages returns a copy capped to the newest messages', () => {
	const messages = Array.from({ length: 5 }, (_, index) => ({ index }));
	assert.deepEqual(getRecentMessages(messages, 3).map(message => message.index), [2, 3, 4]);
	assert.notEqual(getRecentMessages(messages, 10), messages);
	assert.deepEqual(getRecentMessages(null, 3), []);
});

test('isNearBottomScroll uses a small threshold for sticky autoscroll', () => {
	assert.equal(isNearBottomScroll(1000, 920, 80), true);
	assert.equal(isNearBottomScroll(1000, 800, 80), false);
	assert.equal(isNearBottomScroll(1000, 850, 80, 100), true);
});
