import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';

// Force the HAS_NATIVE_BASE64 branch in util.serverCrypto.js even on engines without
// Uint8Array#toBase64, by installing spec-shaped shims (canonical RFC 4648, via Buffer)
// before the module is imported. This pins the native branch to the fallback's exact bytes.
// 通过在导入模块前安装符合规范的 shim（基于 Buffer 的 RFC 4648 规范输出），强制走
// util.serverCrypto.js 的 HAS_NATIVE_BASE64 分支，校验原生分支与后备路径字节级一致。
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
	Object.defineProperty(Uint8Array.prototype, 'toBase64', {
		value: function toBase64() {
			return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64');
		},
		writable: true,
		configurable: true
	});
}
if (typeof Uint8Array.fromBase64 !== 'function') {
	Object.defineProperty(Uint8Array, 'fromBase64', {
		value: function fromBase64(value) {
			return new Uint8Array(Buffer.from(value, 'base64'));
		},
		writable: true,
		configurable: true
	});
}

const { base64ToBytes, bytesToBase64, deriveServerLinkKey, encryptServerEnvelope, decryptServerEnvelope } =
	await import('../../client/js/util.serverCrypto.js');
const { decryptMessage, encryptMessage } = await import('../../worker/utils.js');

// The pre-optimization chunked btoa path, as the byte-for-byte reference.
// 优化前的分块 btoa 路径，作为逐字节参照。
function referenceBytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

test('native base64 branch emits the exact same bytes as the chunked fallback', () => {
	for (const size of [0, 1, 2, 3, 31, 0x8000 - 1, 0x8000, 0x8000 + 1, 200001]) {
		const bytes = new Uint8Array(randomBytes(size));
		const encoded = bytesToBase64(bytes);
		assert.equal(encoded, referenceBytesToBase64(bytes));
		assert.equal(Buffer.compare(Buffer.from(base64ToBytes(encoded)), Buffer.from(bytes)), 0);
	}
});

test('server envelopes built on the native branch still interop with the worker', async () => {
	const sharedSecret = randomBytes(48);
	const clientKey = await deriveServerLinkKey(new Uint8Array(sharedSecret));
	const workerKey = Buffer.from(hkdfSync('sha256', sharedSecret, 'nodecrypt-server-link-v2', 'aes-256-gcm', 32));
	const payload = { a: 'w', p: { peer: 'x'.repeat(200000) } };

	const envelope = await encryptServerEnvelope(payload, clientKey);
	assert.deepEqual(decryptMessage(envelope, workerKey), payload);
	assert.deepEqual(await decryptServerEnvelope(encryptMessage(payload, workerKey), clientKey), payload);
});
