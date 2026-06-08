import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getExpectedRoomHash,
	getRoomObjectName,
	isJoinRoomAllowed,
	shouldRedirectToHttps
} from '../../worker/index.js';

const roomA = 'a'.repeat(64);
const roomB = 'b'.repeat(64);

test('worker routes valid room hash to a stable Durable Object shard', () => {
	const url = new URL(`https://example.test/?room=${roomA.toUpperCase()}`);
	assert.equal(getExpectedRoomHash(url), roomA);
	assert.equal(getRoomObjectName(url), `room:${roomA}`);
});

test('worker falls back to default shard for missing or invalid room hash', () => {
	assert.equal(getExpectedRoomHash(new URL('https://example.test/')), null);
	assert.equal(getRoomObjectName(new URL('https://example.test/')), 'room:default');
	assert.equal(getExpectedRoomHash(new URL('https://example.test/?room=bad')), null);
	assert.equal(getRoomObjectName(new URL('https://example.test/?room=bad')), 'room:default');
});

test('worker redirects only plain http non-local requests', () => {
	assert.equal(shouldRedirectToHttps(new Request('http://example.test/'), new URL('http://example.test/')), true);
	assert.equal(shouldRedirectToHttps(new Request('https://example.test/'), new URL('https://example.test/')), false);
	assert.equal(shouldRedirectToHttps(new Request('http://127.0.0.1:8787/'), new URL('http://127.0.0.1:8787/')), false);
});

test('worker allows joins only when route shard and encrypted room match', () => {
	assert.equal(isJoinRoomAllowed(roomA, roomA), true);
	assert.equal(isJoinRoomAllowed(roomA, roomB), false);
	assert.equal(isJoinRoomAllowed(null, roomB), true);
});
