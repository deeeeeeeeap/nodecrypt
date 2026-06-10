import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { base64ToBytes, bytesToBase64 } from '../../client/js/util.serverCrypto.js';
import { arrayBufferToBase64, combineVolumeData } from '../../client/js/util.file.codec.js';
import NodeCrypt from '../../client/js/NodeCrypt.js';

// Reference implementation: the pre-optimization chunked btoa/atob path. The active codec
// (native or fallback) must stay byte-identical to it on every input.
// 参照实现：优化前的分块 btoa/atob 路径。当前生效的编解码（原生或后备）必须与其逐字节一致。
function referenceBytesToBase64(bytes) {
	const uint8Array = new Uint8Array(bytes);
	let binary = '';
	for (let i = 0; i < uint8Array.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, uint8Array.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function sampleBuffers() {
	const sizes = [0, 1, 2, 3, 4, 31, 32, 33, 0x8000 - 1, 0x8000, 0x8000 + 1, 200001];
	return sizes.map(size => new Uint8Array(randomBytes(size)));
}

// The previous client-message codec used the npm buffer polyfill; Node's Buffer produces the
// same canonical UTF-8/base64 bytes, so it stands in as the old-wire-format reference here.
// 旧客户端消息编解码使用 npm buffer polyfill；Node 内建 Buffer 输出与其规范 UTF-8/base64 完全一致，
// 因此在此作为旧线上格式的参照。
async function referenceEncryptClientMessage(message, key) {
	const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
	const ciphertext = await crypto.subtle.encrypt({
		name: 'AES-GCM',
		iv: nonce
	}, key, Buffer.from(JSON.stringify(message), 'utf8'));
	return `g1|${nonce.toString('base64')}|${Buffer.from(ciphertext).toString('base64')}`;
}

async function referenceDecryptClientMessage(envelope, key) {
	const parts = envelope.split('|');
	assert.equal(parts.length, 3);
	assert.equal(parts[0], 'g1');
	const plaintext = await crypto.subtle.decrypt({
		name: 'AES-GCM',
		iv: Buffer.from(parts[1], 'base64')
	}, key, Buffer.from(parts[2], 'base64'));
	return JSON.parse(Buffer.from(plaintext).toString('utf8'));
}

async function makeClientKey() {
	return crypto.subtle.importKey('raw', randomBytes(32), {
		name: 'AES-GCM'
	}, false, ['encrypt', 'decrypt']);
}

test('bytesToBase64/base64ToBytes stay canonical and round-trip across sizes', () => {
	for (const bytes of sampleBuffers()) {
		const encoded = bytesToBase64(bytes);
		assert.equal(encoded, Buffer.from(bytes).toString('base64'));
		assert.equal(encoded, referenceBytesToBase64(bytes));
		assert.equal(Buffer.compare(Buffer.from(base64ToBytes(encoded)), Buffer.from(bytes)), 0);
	}
});

test('arrayBufferToBase64 matches the old implementation for buffers, views and offsets', () => {
	const big = new Uint8Array(randomBytes(150000));
	const candidates = [
		new Uint8Array(0),
		new Uint8Array([7]),
		big,
		big.subarray(3, 3 + 70000), // non-zero byteOffset view, like the new subarray volume split
		big.buffer
	];
	for (const candidate of candidates) {
		const view = candidate instanceof Uint8Array ? candidate : new Uint8Array(candidate);
		assert.equal(arrayBufferToBase64(candidate), referenceBytesToBase64(view));
	}
});

test('combineVolumeData restores the exact original bytes from subarray-split volumes', () => {
	const original = new Uint8Array(randomBytes(200000));
	const volumeSize = 0x8000 + 17;
	const volumes = [];
	for (let i = 0; i < original.length; i += volumeSize) {
		volumes.push(arrayBufferToBase64(original.subarray(i, i + volumeSize)));
	}
	assert.equal(Buffer.compare(Buffer.from(combineVolumeData(volumes)), Buffer.from(original)), 0);
});

test('g1 client envelopes interop with the previous polyfill-based codec in both directions', async () => {
	const key = await makeClientKey();
	const client = new NodeCrypt();
	// volume-shaped payload > 0x8000 chars exercises the chunked base64 fallback
	const message = {
		a: 'm',
		t: 'file_volume',
		d: {
			type: 'file_volume',
			fileId: 'file_0123456789abcdef',
			volumeIndex: 42,
			volumeData: bytesToBase64(new Uint8Array(randomBytes(96 * 1024))),
			isLast: false
		}
	};

	const fromNew = await client.encryptClientMessage(message, key);
	assert.deepEqual(await referenceDecryptClientMessage(fromNew, key), message);

	const fromReference = await referenceEncryptClientMessage(message, key);
	assert.deepEqual(await client.decryptClientMessage(fromReference, key), message);
});

test('g1 envelope keeps the exact wire shape: 12-byte nonce and ciphertext||16-byte tag', async () => {
	const key = await makeClientKey();
	const client = new NodeCrypt();
	const message = { a: 'm', t: 'text', d: 'hello' };
	const envelope = await client.encryptClientMessage(message, key);
	const parts = envelope.split('|');
	assert.equal(parts.length, 3);
	assert.equal(parts[0], 'g1');
	assert.equal(Buffer.from(parts[1], 'base64').length, 12);
	assert.equal(Buffer.from(parts[2], 'base64').length, Buffer.byteLength(JSON.stringify(message), 'utf8') + 16);
});

test('hoisted plaintext encryption is equivalent to per-recipient encryptClientMessage', async () => {
	const keyA = await makeClientKey();
	const keyB = await makeClientKey();
	const client = new NodeCrypt();
	const message = { a: 'm', t: 'text', d: 'broadcast '.repeat(1000) };
	// sendChannelMessage now encodes once and calls encryptClientPlaintext per recipient
	const plaintext = new TextEncoder().encode(JSON.stringify(message));

	const forA = await client.encryptClientPlaintext(plaintext, keyA);
	const forB = await client.encryptClientPlaintext(plaintext, keyB);
	assert.notEqual(forA, forB); // independent nonces and keys
	assert.deepEqual(await client.decryptClientMessage(forA, keyA), message);
	assert.deepEqual(await referenceDecryptClientMessage(forB, keyB), message);
});

test('decryptClientMessage returns {} for malformed or tampered envelopes', async () => {
	const key = await makeClientKey();
	const client = new NodeCrypt();
	const envelope = await client.encryptClientMessage({ a: 'm', t: 'text', d: 'x' }, key);
	const parts = envelope.split('|');
	const payload = Buffer.from(parts[2], 'base64');
	payload[payload.length - 1] ^= 0x01; // flip a tag byte
	const tampered = `${parts[0]}|${parts[1]}|${payload.toString('base64')}`;

	assert.deepEqual(await client.decryptClientMessage('not-an-envelope', key), {});
	assert.deepEqual(await client.decryptClientMessage('g1|only-two', key), {});
	assert.deepEqual(await client.decryptClientMessage(tampered, key), {});
});
