import test from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync, randomBytes } from 'node:crypto';

import { decryptMessage, encryptMessage } from '../../worker/utils.js';
import {
	decryptServerEnvelope,
	deriveServerLinkKey,
	encryptServerEnvelope
} from '../../client/js/util.serverCrypto.js';

// Must match the protocol v2 constants in client/js/util.serverCrypto.js and worker/index.js.
const HKDF_SALT = 'nodecrypt-server-link-v2';
const HKDF_INFO = 'aes-256-gcm';

function deriveWorkerKey(sharedSecret) {
	return Buffer.from(hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, 32));
}

async function deriveBothKeys() {
	const sharedSecret = randomBytes(48); // simulated ECDH P-384 shared secret
	const clientKey = await deriveServerLinkKey(new Uint8Array(sharedSecret));
	const workerKey = deriveWorkerKey(sharedSecret);
	return { clientKey, workerKey };
}

// Flip one byte of the base64 payload part (ciphertext || tag) while keeping valid base64.
function flipPayloadByte(envelope, index) {
	const [ivPart, payloadPart] = envelope.split('|');
	const payload = Buffer.from(payloadPart, 'base64');
	const target = index < 0 ? payload.length + index : index;
	payload[target] ^= 0x01;
	return ivPart + '|' + payload.toString('base64');
}

test('client envelope decrypts on worker after HKDF key agreement', async () => {
	const { clientKey, workerKey } = await deriveBothKeys();
	const payload = { a: 'j', p: 'f'.repeat(64) };

	const envelope = await encryptServerEnvelope(payload, clientKey);
	assert.equal(typeof envelope, 'string');
	assert.deepEqual(decryptMessage(envelope, workerKey), payload);
});

test('worker envelope decrypts on client after HKDF key agreement', async () => {
	const { clientKey, workerKey } = await deriveBothKeys();
	const payload = { a: 'l', p: ['client-one', 'client-two'] };

	const envelope = encryptMessage(payload, workerKey);
	assert.equal(typeof envelope, 'string');
	assert.deepEqual(await decryptServerEnvelope(envelope, clientKey), payload);
});

test('tampered envelopes fail authentication in both directions', async () => {
	const { clientKey, workerKey } = await deriveBothKeys();

	const fromClient = await encryptServerEnvelope({ a: 'c', p: 'payload', c: 'peer' }, clientKey);
	assert.equal(decryptMessage(flipPayloadByte(fromClient, 0), workerKey), null);
	assert.equal(decryptMessage(flipPayloadByte(fromClient, -1), workerKey), null);

	const fromWorker = encryptMessage({ a: 'c', p: 'payload', c: 'peer' }, workerKey);
	assert.equal(await decryptServerEnvelope(flipPayloadByte(fromWorker, 0), clientKey), null);
	assert.equal(await decryptServerEnvelope(flipPayloadByte(fromWorker, -1), clientKey), null);
	assert.equal(await decryptServerEnvelope('garbage', clientKey), null);
});

test('large payloads survive the chunked base64 round-trip', async () => {
	const { clientKey, workerKey } = await deriveBothKeys();
	// > 0x8000 bytes forces multiple String.fromCharCode chunks in util.serverCrypto.js
	const payload = { a: 'w', p: { peer: 'x'.repeat(200000) } };

	const envelope = await encryptServerEnvelope(payload, clientKey);
	assert.deepEqual(decryptMessage(envelope, workerKey), payload);
	assert.deepEqual(await decryptServerEnvelope(encryptMessage(payload, workerKey), clientKey), payload);
});
