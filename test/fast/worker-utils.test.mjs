import test from 'node:test';
import assert from 'node:assert/strict';

import {
	appendToHistoryBacklog,
	createRateLimiter,
	decryptMessage,
	encryptMessage,
	isArray,
	isObject,
	isString,
	packClientAttachment,
	unpackClientAttachment
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

test('appendToHistoryBacklog rejects oversized or non-string entries untouched', () => {
	const limits = { maxMessages: 10, maxBytes: 1000, maxEntryBytes: 10 };
	const backlog = ['keep'];
	assert.equal(appendToHistoryBacklog(backlog, 'x'.repeat(11), limits), false);
	assert.equal(appendToHistoryBacklog(backlog, 42, limits), false);
	assert.equal(appendToHistoryBacklog(backlog, null, limits), false);
	assert.deepEqual(backlog, ['keep']);
});

test('appendToHistoryBacklog evicts oldest entries past the message cap', () => {
	const limits = { maxMessages: 3, maxBytes: 1000, maxEntryBytes: 100 };
	const backlog = [];
	for (const entry of ['m1', 'm2', 'm3', 'm4']) {
		assert.equal(appendToHistoryBacklog(backlog, entry, limits), true);
	}
	assert.deepEqual(backlog, ['m2', 'm3', 'm4']);
});

test('appendToHistoryBacklog evicts oldest entries past the byte cap', () => {
	const limits = { maxMessages: 100, maxBytes: 10, maxEntryBytes: 10 };
	const backlog = [];
	appendToHistoryBacklog(backlog, 'aaaa', limits);
	appendToHistoryBacklog(backlog, 'bbbb', limits);
	appendToHistoryBacklog(backlog, 'cccc', limits);
	assert.deepEqual(backlog, ['bbbb', 'cccc']);
});

test('client attachment round-trips through pack/unpack with a 32-byte shared key', () => {
	const shared = Buffer.alloc(32, 5);
	const channel = 'f'.repeat(64);
	const packed = packClientAttachment({
		clientId: 'abc123abc123abc1',
		shared,
		channel,
		expectedRoomHash: channel,
		seen: 12345
	});
	// shared must travel as base64 (attachments are structured-clone snapshots)
	assert.equal(packed.shared, shared.toString('base64'));

	const unpacked = unpackClientAttachment(packed);
	assert.equal(unpacked.clientId, 'abc123abc123abc1');
	assert.equal(Buffer.compare(unpacked.shared, shared), 0);
	assert.equal(unpacked.channel, channel);
	assert.equal(unpacked.expectedRoomHash, channel);
	assert.equal(unpacked.seen, 12345);
});

test('client attachment unpack handles pre-handshake state and rejects malformed input', () => {
	const packed = packClientAttachment({ clientId: 'abc123abc123abc1', shared: null, channel: null, expectedRoomHash: null, seen: 0 });
	assert.deepEqual(unpackClientAttachment(packed), {
		clientId: 'abc123abc123abc1',
		shared: null,
		channel: null,
		expectedRoomHash: null,
		seen: 0
	});

	assert.equal(unpackClientAttachment(null), null);
	assert.equal(unpackClientAttachment('nope'), null);
	assert.equal(unpackClientAttachment({}), null);
	// shared present but not a valid 32-byte key -> unrecoverable
	assert.equal(unpackClientAttachment({ clientId: 'abc123abc123abc1', shared: 'AAAA' }), null);
	assert.equal(unpackClientAttachment({ clientId: 'abc123abc123abc1', shared: 1234 }), null);
});
