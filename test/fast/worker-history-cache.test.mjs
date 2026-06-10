import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatRoom } from '../../worker/index.js';
import { decryptMessage } from '../../worker/utils.js';

// In-memory stand-in for DO storage that counts operations, so the tests can prove the
// history cache removes reads while keeping storage the byte-identical source of truth.
// DO storage 的内存替身并统计操作次数，用于证明历史缓存省去了读取、且 storage 内容保持逐字节一致。
class FakeStorage {
	constructor() {
		this.map = new Map();
		this.gets = 0;
		this.puts = 0;
		this.deletes = 0;
	}
	async get(key) {
		this.gets += 1;
		return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
	}
	async put(key, value) {
		this.puts += 1;
		this.map.set(key, structuredClone(value));
	}
	async delete(key) {
		this.deletes += 1;
		this.map.delete(key);
	}
	async list({ prefix } = {}) {
		const result = new Map();
		for (const [key, value] of this.map) {
			if (!prefix || key.startsWith(prefix)) {
				result.set(key, structuredClone(value));
			}
		}
		return result;
	}
	async setAlarm() {}
	async deleteAlarm() {}
}

async function makeRoom() {
	if (typeof globalThis.WebSocketRequestResponse !== 'function') {
		globalThis.WebSocketRequestResponse = function WebSocketRequestResponse() {};
	}
	const storage = new FakeStorage();
	const state = {
		storage,
		blockConcurrencyWhile: (fn) => fn(),
		setWebSocketAutoResponse() {},
		getWebSockets: () => []
	};
	const room = new ChatRoom(state, {});
	await room.ready; // RSA bootstrap touches storage; reset counters afterwards
	storage.gets = 0;
	storage.puts = 0;
	storage.deletes = 0;
	return { room, storage };
}

const channel = 'a'.repeat(64);
const historyKey = `history:${channel}`;

test('appendHistoryEntry reads storage once and serves later appends from cache', async () => {
	const { room, storage } = await makeRoom();

	await room.appendHistoryEntry(channel, 'h1|n1|c1');
	assert.equal(storage.gets, 1);
	assert.equal(storage.puts, 1);

	await room.appendHistoryEntry(channel, 'h1|n2|c2');
	await room.appendHistoryEntry(channel, 'h1|n3|c3');
	assert.equal(storage.gets, 1); // warm cache: no further reads
	assert.equal(storage.puts, 3); // every accepted entry still persisted
	assert.deepEqual(storage.map.get(historyKey), ['h1|n1|c1', 'h1|n2|c2', 'h1|n3|c3']);
});

test('history caps still evict through the cached working copy', async () => {
	const { room, storage } = await makeRoom();
	room.config.historyMaxMessages = 2;

	for (const entry of ['h1|1|x', 'h1|2|x', 'h1|3|x']) {
		await room.appendHistoryEntry(channel, entry);
	}
	assert.deepEqual(storage.map.get(historyKey), ['h1|2|x', 'h1|3|x']);

	const oversized = 'x'.repeat(16 * 1024 + 1);
	const putsBefore = storage.puts;
	await room.appendHistoryEntry(channel, oversized);
	assert.equal(storage.puts, putsBefore); // rejected entry never persisted
	assert.deepEqual(storage.map.get(historyKey), ['h1|2|x', 'h1|3|x']);
});

test('deleteHistoryBacklog drops the cache so the next append re-reads storage', async () => {
	const { room, storage } = await makeRoom();

	await room.appendHistoryEntry(channel, 'h1|old|x');
	await room.deleteHistoryBacklog(channel);
	assert.equal(storage.map.has(historyKey), false);

	await room.appendHistoryEntry(channel, 'h1|new|x');
	assert.equal(storage.gets, 2); // cache invalidated by delete -> one more read
	assert.deepEqual(storage.map.get(historyKey), ['h1|new|x']);
});

test('purgeOrphanHistory removes orphaned backlog from storage and cache alike', async () => {
	const { room, storage } = await makeRoom();

	await room.appendHistoryEntry(channel, 'h1|orphan|x');
	room.channels = {};
	await room.purgeOrphanHistory();
	assert.equal(storage.map.has(historyKey), false);

	await room.appendHistoryEntry(channel, 'h1|fresh|x');
	assert.equal(storage.gets, 2); // purge invalidated the cache entry
	assert.deepEqual(storage.map.get(historyKey), ['h1|fresh|x']);

	// a channel with live members keeps its backlog
	room.channels = { [channel]: ['client-1'] };
	await room.purgeOrphanHistory();
	assert.deepEqual(storage.map.get(historyKey), ['h1|fresh|x']);
});

test('sendHistoryBacklog serves the cached backlog without extra storage reads', async () => {
	const { room, storage } = await makeRoom();

	await room.appendHistoryEntry(channel, 'h1|a|x');
	await room.appendHistoryEntry(channel, 'h1|b|x');

	const sent = [];
	const shared = Buffer.alloc(32, 7);
	room.clients['client-1'] = {
		clientId: 'client-1',
		connection: {
			readyState: 1,
			send(message) {
				sent.push(message);
			}
		},
		shared,
		channel
	};

	const getsBefore = storage.gets;
	await room.sendHistoryBacklog('client-1', channel);
	assert.equal(storage.gets, getsBefore); // warm cache: no storage read on join replay
	assert.equal(sent.length, 1);
	assert.deepEqual(decryptMessage(sent[0], shared), {
		a: 'h',
		p: ['h1|a|x', 'h1|b|x']
	});
});
