import test from 'node:test';
import assert from 'node:assert/strict';

import {
	CHAT_STORED_MESSAGE_LIMIT,
	appendMessage,
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

test('appendMessage trims the oldest messages once the limit is exceeded', () => {
	const messages = [];
	for (let index = 0; index < 7; index++) {
		appendMessage(messages, { index }, 5);
	}
	assert.deepEqual(messages.map(message => message.index), [2, 3, 4, 5, 6]);
});

test('appendMessage mutates in place and returns the same array reference', () => {
	const messages = [{ index: 0 }, { index: 1 }];
	const result = appendMessage(messages, { index: 2 }, 2);
	assert.equal(result, messages);
	assert.deepEqual(messages.map(message => message.index), [1, 2]);
});

test('appendMessage defaults to CHAT_STORED_MESSAGE_LIMIT', () => {
	const messages = Array.from({ length: CHAT_STORED_MESSAGE_LIMIT }, (_, index) => ({ index }));
	appendMessage(messages, { index: CHAT_STORED_MESSAGE_LIMIT });
	assert.equal(messages.length, CHAT_STORED_MESSAGE_LIMIT);
	assert.equal(messages[0].index, 1);
	assert.equal(messages[messages.length - 1].index, CHAT_STORED_MESSAGE_LIMIT);
});
