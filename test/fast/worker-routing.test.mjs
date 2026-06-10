import test from 'node:test';
import assert from 'node:assert/strict';

import worker, {
	getExpectedRoomHash,
	getRoomObjectName,
	isJoinRoomAllowed,
	shouldRedirectToHttps
} from '../../worker/index.js';

const roomA = 'a'.repeat(64);
const roomB = 'b'.repeat(64);

// Minimal request stub: worker.fetch only reads url and headers.get().
function makeUpgradeRequest(url) {
	return {
		url,
		headers: {
			get(name) {
				return name.toLowerCase() === 'upgrade' ? 'websocket' : null;
			}
		}
	};
}

test('worker routes valid room hash to a stable Durable Object shard', () => {
	const url = new URL(`https://example.test/?room=${roomA.toUpperCase()}`);
	assert.equal(getExpectedRoomHash(url), roomA);
	assert.equal(getRoomObjectName(url), `room:${roomA}`);
});

test('worker rejects missing or invalid room hash instead of falling back', () => {
	assert.equal(getExpectedRoomHash(new URL('https://example.test/')), null);
	assert.equal(getRoomObjectName(new URL('https://example.test/')), null);
	assert.equal(getExpectedRoomHash(new URL('https://example.test/?room=bad')), null);
	assert.equal(getRoomObjectName(new URL('https://example.test/?room=bad')), null);
});

test('worker returns 400 for websocket upgrades without a valid room', async () => {
	const env = {
		CHAT_ROOM: {
			idFromName() {
				throw new Error('must not shard invalid rooms');
			}
		}
	};
	const missing = await worker.fetch(makeUpgradeRequest('https://example.test/'), env, {});
	assert.equal(missing.status, 400);
	const invalid = await worker.fetch(makeUpgradeRequest('https://example.test/?room=bad'), env, {});
	assert.equal(invalid.status, 400);
});

test('worker redirects only plain http non-local requests', () => {
	assert.equal(shouldRedirectToHttps(new Request('http://example.test/'), new URL('http://example.test/')), true);
	assert.equal(shouldRedirectToHttps(new Request('https://example.test/'), new URL('https://example.test/')), false);
	assert.equal(shouldRedirectToHttps(new Request('http://127.0.0.1:8787/'), new URL('http://127.0.0.1:8787/')), false);
});

test('worker allows joins only when route shard and encrypted room match', () => {
	assert.equal(isJoinRoomAllowed(roomA, roomA), true);
	assert.equal(isJoinRoomAllowed(roomA, roomB), false);
	assert.equal(isJoinRoomAllowed(null, roomB), false);
	assert.equal(isJoinRoomAllowed('', roomB), false);
});
