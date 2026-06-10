import test from 'node:test';
import assert from 'node:assert/strict';

function installBrowserStubs() {
	globalThis.window = {
		fileTransfers: new Map(),
		addEventListener() {},
		URL: {
			createObjectURL() {
				return 'blob:test'
			}
		}
	};
	globalThis.document = {
		addEventListener() {},
		querySelector() {
			return null
		},
		getElementById() {
			return null
		},
		createElement() {
			return {
				className: '',
				dataset: {},
				style: {},
				setAttribute() {},
				appendChild() {},
				addEventListener() {},
				querySelector() {
					return null
				},
				remove() {}
			}
		}
	};
	globalThis.Element = class Element {};
	globalThis.FileReader = class FileReader {};
}

installBrowserStubs();

const fileModule = await import('../../client/js/util.file.js');

test('getMissingRanges returns capped missing direct-transfer ranges', () => {
	const transfer = {
		totalVolumes: 8,
		receivedVolumes: new Set([0, 3, 4, 7]),
		volumeData: ['a', undefined, undefined, 'd', 'e', undefined, undefined, 'h']
	};
	assert.deepEqual(fileModule.getMissingRanges(transfer), [[1, 2], [5, 6]]);
	assert.deepEqual(fileModule.getMissingRanges(transfer, 1), [[1, 2]]);
	assert.deepEqual(fileModule.getMissingRanges(transfer, 64, 1), [[1, 1]]);
	assert.deepEqual(fileModule.getMissingRanges(transfer, 64, 256, 4), [[1, 2]]);
});

test('normalizeMissingRanges rejects malformed ranges and caps request size', () => {
	assert.deepEqual(fileModule.normalizeMissingRanges([[1, 3], [5, 7]], 10), [[1, 3], [5, 7]]);
	assert.deepEqual(fileModule.normalizeMissingRanges([[1, 300]], 400), [[1, 256]]);
	assert.deepEqual(fileModule.normalizeMissingRanges([[3, 1]], 10), []);
	assert.deepEqual(fileModule.normalizeMissingRanges('bad', 10), []);
});

test('file presentation exposes repaired and waiting states', () => {
	window.fileTransfers.set('file_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', {
		fileId: 'file_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
		direction: 'receive',
		status: 'completed',
		repairStatus: 'completed',
		totalVolumes: 2,
		receivedVolumes: new Set([0, 1]),
		nackState: {
			requestSeq: 1
		}
	});
	const repaired = fileModule.getFileTransferPresentation('file_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
	assert.equal(repaired.state, 'repaired');
	assert.equal(repaired.statusText, 'Repaired');
	assert.equal(repaired.showDownload, true);

	window.fileTransfers.set('file_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', {
		fileId: 'file_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
		direction: 'receive',
		status: 'receiving',
		repairStatus: 'waiting',
		totalVolumes: 2,
		receivedVolumes: new Set([0])
	});
	const waiting = fileModule.getFileTransferPresentation('file_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb');
	assert.equal(waiting.state, 'repair-waiting');
	assert.equal(waiting.statusText, 'Waiting for repair');
	assert.equal(waiting.showDownload, false);
});
