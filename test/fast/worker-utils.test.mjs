import test from 'node:test';
import assert from 'node:assert/strict';

import {
	decryptMessage,
	encryptMessage,
	isArray,
	isObject,
	isString
} from '../../worker/utils.js';

test('worker type guards accept only expected runtime shapes', () => {
	assert.equal(isString('alice'), true);
	assert.equal(isString(''), false);
	assert.equal(isString(new String('alice')), true);
	assert.equal(isArray([1, 2]), true);
	assert.equal(isArray({ 0: 1 }), false);
	assert.equal(isObject({ ok: true }), true);
	assert.equal(isObject(null), false);
	assert.equal(isObject([]), false);
});

test('worker encryption round-trips structured payloads', () => {
	const key = Buffer.alloc(32, 7);
	const payload = {
		a: 'w',
		p: {
			client: 'ciphertext'
		}
	};
	const encrypted = encryptMessage(payload, key);
	assert.equal(typeof encrypted, 'string');
	assert.notEqual(encrypted.length, 0);
	assert.deepEqual(decryptMessage(encrypted, key), payload);
});
