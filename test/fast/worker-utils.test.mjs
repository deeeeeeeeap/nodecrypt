import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createRateLimiter,
	decryptMessage,
	encryptMessage,
	isArray,
	isObject,
	isString
} from '../../worker/utils.js';

const key = Buffer.alloc(32, 7);

// Flip one byte of the base64 payload part (ciphertext || 16-byte tag); negative index counts from the tag end.
function flipPayloadByte(envelope, index) {
	const [ivPart, payloadPart] = envelope.split('|');
	const payload = Buffer.from(payloadPart, 'base64');
	const target = index < 0 ? payload.length + index : index;
	payload[target] ^= 0x01;
	return ivPart + '|' + payload.toString('base64');
}

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

test('worker encryption round-trips structured payloads with AES-256-GCM', () => {
	const payload = {
		a: 'w',
		p: {
			client: 'ciphertext'
		}
	};
	const encrypted = encryptMessage(payload, key);
	assert.equal(typeof encrypted, 'string');
	assert.notEqual(encrypted.length, 0);

	const [ivPart, payloadPart] = encrypted.split('|');
	assert.equal(Buffer.from(ivPart, 'base64').length, 12);
	// ciphertext is plaintext-length (GCM is a stream mode) plus the 16-byte tag
	assert.equal(Buffer.from(payloadPart, 'base64').length, Buffer.byteLength(JSON.stringify(payload), 'utf8') + 16);

	assert.deepEqual(decryptMessage(encrypted, key), payload);
});

test('worker decryption returns null for tampered ciphertext or tag', () => {
	const encrypted = encryptMessage({ a: 'j', p: 'f'.repeat(64) }, key);
	assert.deepEqual(decryptMessage(encrypted, key), { a: 'j', p: 'f'.repeat(64) });

	// tampered ciphertext byte (before the tag)
	assert.equal(decryptMessage(flipPayloadByte(encrypted, 0), key), null);
	// tampered auth tag byte (last 16 bytes)
	assert.equal(decryptMessage(flipPayloadByte(encrypted, -1), key), null);
});

test('worker decryption returns null for malformed envelopes and wrong keys', () => {
	const encrypted = encryptMessage({ a: 'h', p: 'x' }, key);
	assert.equal(decryptMessage('not-an-envelope', key), null);
	assert.equal(decryptMessage('||', key), null);
	assert.equal(decryptMessage('AAAA|AAAA', key), null);
	assert.equal(decryptMessage(encrypted, Buffer.alloc(32, 9)), null);
});

test('createRateLimiter enforces message count and rolls the window', () => {
	const limiter = createRateLimiter({ windowMs: 10000, maxMessages: 3, maxBytes: 1024 });
	const start = 100000;
	assert.equal(limiter.allow(1, start), true);
	assert.equal(limiter.allow(1, start + 10), true);
	assert.equal(limiter.allow(1, start + 20), true);
	assert.equal(limiter.allow(1, start + 30), false);
	assert.equal(limiter.allow(1, start + 9999), false);
	// window rollover resets the budget
	assert.equal(limiter.allow(1, start + 10000), true);
});

test('createRateLimiter enforces byte budget and rolls the window', () => {
	const limiter = createRateLimiter({ windowMs: 10000, maxMessages: 100, maxBytes: 100 });
	const start = 200000;
	assert.equal(limiter.allow(80, start), true);
	assert.equal(limiter.allow(80, start + 1), false);
	assert.equal(limiter.allow(80, start + 10001), true);
});
