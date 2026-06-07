import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

let baseUrl = process.env.SMOKE_BASE_URL || '';
const shouldStartWrangler = !process.env.SMOKE_BASE_URL;
const roomName = `smoke${Date.now().toString(36).slice(-8)}`;
const password = 'pw123456';
const wrongPassword = 'pw654321';
const message = `history-smoke-${Date.now()}`;
const liveMessage = `live-smoke-${Date.now()}`;
const fileName = `nodecrypt-smoke-${Date.now()}.txt`;
const filePath = join(tmpdir(), fileName);
const largeFileName = `nodecrypt-large-${Date.now()}.bin`;
const largeFilePath = join(tmpdir(), largeFileName);
const privateLargeFileName = `nodecrypt-private-large-${Date.now()}.bin`;
const privateLargeFilePath = join(tmpdir(), privateLargeFileName);
const multiReceiverLargeFileName = `nodecrypt-multi-large-${Date.now()}.bin`;
const multiReceiverLargeFilePath = join(tmpdir(), multiReceiverLargeFileName);
const expiredLargeFileName = `nodecrypt-expired-large-${Date.now()}.bin`;
const expiredLargeFilePath = join(tmpdir(), expiredLargeFileName);
const reconnectLargeFileName = `nodecrypt-reconnect-large-${Date.now()}.bin`;
const reconnectLargeFilePath = join(tmpdir(), reconnectLargeFileName);
const largeFileDropIndices = [3, 4, 8];
const privateLargeFileDropIndices = [2, 5];
const multiReceiverDropIndices = [6, 7];
const expiredLargeFileDropIndices = [4];
const reconnectLargeFileDropIndices = [5];
const tempFilePaths = [
	filePath,
	largeFilePath,
	privateLargeFilePath,
	multiReceiverLargeFilePath,
	expiredLargeFilePath,
	reconnectLargeFilePath,
];
const pageErrors = [];
const consoleErrors = [];

function findChromeExecutable() {
	const candidates = [
		process.env.CHROME_PATH,
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium-browser',
		'/usr/bin/chromium',
	].filter(Boolean);

	return candidates.find((candidate) => existsSync(candidate));
}

async function waitForServer(url, timeoutMs = 60000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// Wrangler is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Timed out waiting for ${url}`);
}

async function getAvailablePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : 0;
			server.close(() => resolve(port))
		})
	})
}

async function waitForWrangler(child, url) {
	let settled = false;
	const exitPromise = new Promise((_, reject) => {
		child.once('exit', (code, signal) => {
			if (settled) return;
			reject(new Error(`Wrangler exited before smoke server was ready: code=${code} signal=${signal || ''}`))
		})
	});
	try {
		await Promise.race([waitForServer(url), exitPromise])
	} finally {
		settled = true
	}
}

function startWrangler(port) {
	const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
	const args = process.platform === 'win32' ?
		['/d', '/s', '/c', `npx wrangler dev --ip 127.0.0.1 --port ${port}`] :
		['wrangler', 'dev', '--ip', '127.0.0.1', '--port', String(port)];
	const child = spawn(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false,
		cwd: process.cwd(),
	});

	child.stdout.on('data', (chunk) => process.stdout.write(chunk));
	child.stderr.on('data', (chunk) => process.stderr.write(chunk));
	return child;
}

function stopProcessTree(child) {
	if (!child || child.killed) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
		return;
	}
	child.kill('SIGTERM');
}

async function newEnglishContext(browser) {
	const context = await browser.newContext({ locale: 'en-US' });
	await context.addInitScript(() => {
		localStorage.setItem('settings', JSON.stringify({
			notify: false,
			sound: false,
			theme: 'theme1',
			language: 'en',
		}));
		const NativeWebSocket = window.WebSocket;
		window.__nodecryptSmokeSockets = [];
		window.WebSocket = function SmokeTrackedWebSocket(...args) {
			const socket = new NativeWebSocket(...args);
			window.__nodecryptSmokeSockets.push(socket);
			return socket;
		};
		window.WebSocket.prototype = NativeWebSocket.prototype;
		Object.defineProperty(window.WebSocket, 'OPEN', { value: NativeWebSocket.OPEN });
		Object.defineProperty(window.WebSocket, 'CLOSED', { value: NativeWebSocket.CLOSED });
		Object.defineProperty(window.WebSocket, 'CLOSING', { value: NativeWebSocket.CLOSING });
		Object.defineProperty(window.WebSocket, 'CONNECTING', { value: NativeWebSocket.CONNECTING });
	});
	return context;
}

function attachPageDiagnostics(page, name) {
	page.on('pageerror', (error) => {
		pageErrors.push({ page: name, text: error.message });
		console.error(`[${name}] pageerror: ${error.message}`);
	});
	page.on('console', (message) => {
		if (message.type() === 'error') {
			consoleErrors.push({ page: name, text: message.text() });
			console.error(`[${name}] console error: ${message.text()}`);
		}
	});
}

async function chatText(page) {
	return page.evaluate(() => document.querySelector('#chat-area')?.innerText || '');
}

async function waitForChatText(page, expected, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await chatText(page)).includes(expected)) return true;
		await page.waitForTimeout(250);
	}
	return false;
}

async function countChatTextOccurrences(page, expected) {
	return page.evaluate((needle) => {
		const text = document.querySelector('#chat-area')?.innerText || '';
		if (!needle) return 0;
		let count = 0;
		let index = text.indexOf(needle);
		while (index !== -1) {
			count += 1;
			index = text.indexOf(needle, index + needle.length)
		}
		return count
	}, expected);
}

async function inputIsCleared(page) {
	return page.evaluate(() => (document.querySelector('.input-message-input')?.innerText || '').trim() === '');
}

async function hasUnexpectedSendFailureText(page) {
	return page.evaluate(() => {
		const text = document.querySelector('#chat-area')?.innerText || '';
		return text.includes('Message send failed') ||
			text.includes('Failed to send files') ||
			text.includes('Cannot send private')
	});
}

async function joinRoom(page, userName, roomPassword = password) {
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
	await page.waitForSelector('#userName', { timeout: 15000 });
	await page.fill('#userName', userName);
	await page.fill('#roomName', roomName);
	await page.fill('#password', roomPassword);
	await page.$eval('#login-form', (form) => form.requestSubmit());

	const secured = await waitForChatText(page, 'connection secured', 20000);
	if (!secured) {
		throw new Error(`${userName} did not establish a secure room connection: ${await chatText(page)}`);
	}
}

async function sendText(page, text) {
	const input = page.locator('.input-message-input').first();
	await input.click();
	await input.fill(text);
	await page.keyboard.press('Enter');
	if (!(await waitForChatText(page, text, 10000))) {
		throw new Error(`Sent message did not render: ${text}`);
	}
	if (!(await inputIsCleared(page))) {
		throw new Error(`Input was not cleared after sending: ${text}`);
	}
	const occurrences = await countChatTextOccurrences(page, text);
	if (occurrences !== 1) {
		throw new Error(`Sent message rendered ${occurrences} times instead of once: ${text}`);
	}
}

async function sendFile(page) {
	writeFileSync(filePath, 'nodecrypt file smoke\n');
	await page.locator('.chat-attach-btn').click();
	await page.setInputFiles('#file-upload-input', filePath);
	await page.locator('.file-upload-send-btn').click();
	if (!(await waitForChatText(page, fileName, 10000))) {
		throw new Error(`Sent file did not render: ${fileName}`);
	}
}

async function sendLargeFile(page, targetName = largeFileName, targetPath = largeFilePath, fill = 65) {
	writeFileSync(targetPath, Buffer.alloc(9 * 1024 * 1024, fill));
	await page.locator('.chat-attach-btn').click();
	await page.setInputFiles('#file-upload-input', targetPath);
	await page.locator('.file-upload-send-btn').click();
	if (!(await waitForChatText(page, targetName, 15000))) {
		throw new Error(`Sent large file did not render: ${targetName}`);
	}
}

async function waitForMember(page, targetName, timeoutMs = 15000) {
	try {
		await page.waitForFunction((name) => {
			return Array.from(document.querySelectorAll('#member-list .member:not(.me) .member-name'))
				.some((element) => (element.textContent || '').includes(name));
		}, targetName, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function isPrivateChatActive(page, targetName) {
	return page.evaluate((name) => {
		return Array.from(document.querySelectorAll('#member-list .member.private-chat-active .member-name'))
			.some((element) => (element.textContent || '').includes(name));
	}, targetName);
}

async function setPrivateChat(page, targetName, enabled) {
	if (!(await waitForMember(page, targetName))) {
		throw new Error(`Member did not appear for private chat: ${targetName}`);
	}
	const active = await isPrivateChatActive(page, targetName);
	if (active === enabled) return;
	await page.locator('#member-list .member:not(.me)').filter({ hasText: targetName }).first().click();
	await page.waitForFunction(({ name, shouldBeActive }) => {
		const activeNow = Array.from(document.querySelectorAll('#member-list .member.private-chat-active .member-name'))
			.some((element) => (element.textContent || '').includes(name));
		return activeNow === shouldBeActive
	}, { name: targetName, shouldBeActive: enabled }, { timeout: 10000 });
}

async function waitForFileTransferCompleted(page, expectedName, timeoutMs = 45000) {
	try {
		await page.waitForFunction((fileNameToFind) => {
			const transfers = window.fileTransfers && typeof window.fileTransfers.values === 'function' ?
				Array.from(window.fileTransfers.values()) :
				[];
			return transfers.some(transfer => transfer.fileName === fileNameToFind && transfer.status === 'completed');
		}, expectedName, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function getFileUiState(page, expectedName) {
	return page.evaluate((fileNameToFind) => {
		const messages = Array.from(document.querySelectorAll('.file-message'));
		const message = messages.find(element => {
			const fileName = element.querySelector('.file-name');
			return fileName && (fileName.textContent || '').includes(fileNameToFind)
		});
		if (!message) return null;
		const status = message.querySelector('.file-status');
		const progressContainer = message.querySelector('.file-progress-container');
		const progress = message.querySelector('.file-progress');
		const downloadButton = message.querySelector('.file-download-btn');
		const progressStyle = progressContainer ? getComputedStyle(progressContainer) : null;
		const downloadStyle = downloadButton ? getComputedStyle(downloadButton) : null;
		return {
			state: message.getAttribute('data-file-state') || '',
			statusText: status ? (status.textContent || '').trim() : '',
			progressWidth: progress ? progress.style.width : '',
			progressVisible: progressStyle ? progressStyle.display !== 'none' && progressStyle.visibility !== 'hidden' && Number(progressStyle.opacity || 1) > 0.01 : false,
			downloadVisible: downloadStyle ? downloadStyle.display !== 'none' && downloadStyle.visibility !== 'hidden' && Number(downloadStyle.opacity || 1) > 0.01 : false,
		}
	}, expectedName);
}

function isRepairWaitingUi(state) {
	return Boolean(state &&
		state.state === 'repair-waiting' &&
		state.statusText.includes('Waiting for repair') &&
		state.progressVisible &&
		!state.downloadVisible)
}

function isRepairFailedUi(state) {
	return Boolean(state &&
		state.state === 'repair-failed' &&
		state.statusText.includes('Repair failed') &&
		state.progressVisible &&
		!state.downloadVisible)
}

function isRepairedUi(state) {
	return Boolean(state &&
		state.state === 'repaired' &&
		state.statusText.includes('Repaired') &&
		state.downloadVisible &&
		state.progressWidth === '100%')
}

async function waitForFileUiState(page, expectedName, expectedState, timeoutMs = 15000) {
	try {
		await page.waitForFunction(({ fileNameToFind, stateToFind }) => {
			const messages = Array.from(document.querySelectorAll('.file-message'));
			return messages.some(element => {
				const fileName = element.querySelector('.file-name');
				return fileName &&
					(fileName.textContent || '').includes(fileNameToFind) &&
					(element.getAttribute('data-file-state') || '') === stateToFind
			})
		}, { fileNameToFind: expectedName, stateToFind: expectedState }, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function closeLatestSmokeSocket(page) {
	return page.evaluate(() => {
		const sockets = window.__nodecryptSmokeSockets || [];
		const openSocket = sockets.slice().reverse().find(socket => socket && socket.readyState === WebSocket.OPEN);
		if (!openSocket) {
			return { closed: false, count: sockets.length, readyState: null }
		}
		openSocket.close();
		return { closed: true, count: sockets.length, readyState: openSocket.readyState }
	});
}

async function waitForLatestSmokeSocketOpen(page, minCount, timeoutMs = 20000) {
	try {
		await page.waitForFunction((expectedCount) => {
			const sockets = window.__nodecryptSmokeSockets || [];
			const latest = sockets[sockets.length - 1];
			return sockets.length >= expectedCount && latest && latest.readyState === WebSocket.OPEN
		}, minCount, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function waitForDroppedChunkCount(page, expectedCount, timeoutMs = 15000) {
	try {
		await page.waitForFunction((count) => {
			return Array.isArray(window.__nodecryptSmokeDroppedFileVolumes) &&
				window.__nodecryptSmokeDroppedFileVolumes.length === count;
		}, expectedCount, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function dropIncomingLargeFileChunks(page, expectedName, volumeIndices = [3]) {
	await page.evaluate(({ fileNameToDrop, volumeIndicesToDrop }) => {
		window.__nodecryptSmokeDropFileId = null;
		window.__nodecryptSmokeDroppedFileVolumes = [];
		if (!window.__nodecryptSmokeOriginalHandleFileMessage) {
			window.__nodecryptSmokeOriginalHandleFileMessage = window.handleFileMessage;
		}
		const originalHandleFileMessage = window.__nodecryptSmokeOriginalHandleFileMessage;
		window.handleFileMessage = function patchedHandleFileMessage(message, ...args) {
			if (message && message.type === 'file_start' && message.fileName === fileNameToDrop) {
				window.__nodecryptSmokeDropFileId = message.fileId;
			}
			if (message && message.type === 'file_complete' && message.fileId === window.__nodecryptSmokeDropFileId) {
				if (window.__nodecryptSmokeDroppedFileVolumes.length === 0) {
					const transfer = window.fileTransfers && window.fileTransfers.get(message.fileId);
					if (transfer && transfer.receivedVolumes) {
						for (const volumeIndexToDrop of volumeIndicesToDrop) {
							transfer.receivedVolumes.delete(volumeIndexToDrop);
							if (Array.isArray(transfer.volumeData)) {
								transfer.volumeData[volumeIndexToDrop] = undefined;
							}
							window.__nodecryptSmokeDroppedFileVolumes.push(volumeIndexToDrop);
						}
						if (transfer.status === 'completed') {
							transfer.status = 'receiving';
						}
					}
				}
			}
			return originalHandleFileMessage.call(window, message, ...args)
		}
	}, { fileNameToDrop: expectedName, volumeIndicesToDrop: volumeIndices });
}

async function restoreIncomingFileChunkDropper(page) {
	await page.evaluate(() => {
		if (window.__nodecryptSmokeOriginalHandleFileMessage) {
			window.handleFileMessage = window.__nodecryptSmokeOriginalHandleFileMessage;
			delete window.__nodecryptSmokeOriginalHandleFileMessage;
		}
	});
}

async function trackResentFileMessages(page, expectedName) {
	await page.evaluate((fileNameToTrack) => {
		window.__nodecryptSmokeTrackFileId = null;
		window.__nodecryptSmokeResentFileVolumes = 0;
		window.__nodecryptSmokeResentFileCompletes = 0;
		if (!window.__nodecryptSmokeOriginalHandleFileMessage) {
			window.__nodecryptSmokeOriginalHandleFileMessage = window.handleFileMessage;
		}
		const originalHandleFileMessage = window.__nodecryptSmokeOriginalHandleFileMessage;
		window.handleFileMessage = function patchedHandleFileMessage(message, ...args) {
			if (message && message.type === 'file_start' && message.fileName === fileNameToTrack) {
				window.__nodecryptSmokeTrackFileId = message.fileId;
			}
			if (message && message.fileId === window.__nodecryptSmokeTrackFileId && message.resent) {
				if (message.type === 'file_volume') {
					window.__nodecryptSmokeResentFileVolumes += 1;
				}
				if (message.type === 'file_complete') {
					window.__nodecryptSmokeResentFileCompletes += 1;
				}
			}
			return originalHandleFileMessage.call(window, message, ...args)
		}
	}, expectedName);
}

async function getResentFileMessageCounts(page) {
	return page.evaluate(() => ({
		resentVolumes: window.__nodecryptSmokeResentFileVolumes || 0,
		resentCompletes: window.__nodecryptSmokeResentFileCompletes || 0,
	}));
}

async function delayIncomingFileCompleteAfterDroppingChunks(page, expectedName, volumeIndices = [3]) {
	await page.evaluate(({ fileNameToDrop, volumeIndicesToDrop }) => {
		window.__nodecryptSmokeDropFileId = null;
		window.__nodecryptSmokeDroppedFileVolumes = [];
		window.__nodecryptSmokeDelayedFileComplete = null;
		if (!window.__nodecryptSmokeOriginalHandleFileMessage) {
			window.__nodecryptSmokeOriginalHandleFileMessage = window.handleFileMessage;
		}
		const originalHandleFileMessage = window.__nodecryptSmokeOriginalHandleFileMessage;
		window.handleFileMessage = function patchedHandleFileMessage(message, ...args) {
			if (message && message.type === 'file_start' && message.fileName === fileNameToDrop) {
				window.__nodecryptSmokeDropFileId = message.fileId;
			}
			if (message && message.type === 'file_complete' && message.fileId === window.__nodecryptSmokeDropFileId) {
				if (!window.__nodecryptSmokeDelayedFileComplete && window.__nodecryptSmokeDroppedFileVolumes.length === 0) {
					const transfer = window.fileTransfers && window.fileTransfers.get(message.fileId);
					if (transfer && transfer.receivedVolumes) {
						for (const volumeIndexToDrop of volumeIndicesToDrop) {
							transfer.receivedVolumes.delete(volumeIndexToDrop);
							if (Array.isArray(transfer.volumeData)) {
								transfer.volumeData[volumeIndexToDrop] = undefined;
							}
							window.__nodecryptSmokeDroppedFileVolumes.push(volumeIndexToDrop);
						}
						if (transfer.status === 'completed') {
							transfer.status = 'receiving';
						}
					}
					window.__nodecryptSmokeDelayedFileComplete = { message, args };
					return
				}
			}
			return originalHandleFileMessage.call(window, message, ...args)
		}
	}, { fileNameToDrop: expectedName, volumeIndicesToDrop: volumeIndices });
}

async function releaseDelayedFileComplete(page) {
	return page.evaluate(() => {
		const pending = window.__nodecryptSmokeDelayedFileComplete;
		if (!pending || !window.__nodecryptSmokeOriginalHandleFileMessage) return false;
		window.__nodecryptSmokeDelayedFileComplete = null;
		window.__nodecryptSmokeOriginalHandleFileMessage.call(window, pending.message, ...pending.args);
		return true
	});
}

async function waitForDelayedFileComplete(page, timeoutMs = 15000) {
	try {
		await page.waitForFunction(() => Boolean(window.__nodecryptSmokeDelayedFileComplete), null, { timeout: timeoutMs });
		return true
	} catch {
		return false
	}
}

async function expireSenderRepairWindow(page, expectedName) {
	return page.evaluate((fileNameToFind) => {
		const transfers = window.fileTransfers && typeof window.fileTransfers.values === 'function' ?
			Array.from(window.fileTransfers.values()) :
			[];
		const transfer = transfers.find(item => item.fileName === fileNameToFind && item.direction === 'send');
		if (!transfer) return false;
		transfer.resumeUntil = Date.now() - 1;
		return true
	}, expectedName);
}

async function getTransferState(page, expectedName) {
	return page.evaluate((fileNameToFind) => {
		const transfers = window.fileTransfers && typeof window.fileTransfers.values === 'function' ?
			Array.from(window.fileTransfers.values()) :
			[];
		const transfer = transfers.find(item => item.fileName === fileNameToFind);
		if (!transfer) return null;
		return {
			status: transfer.status,
			direction: transfer.direction || '',
			scope: transfer.scope || '',
			compression: transfer.compression || '',
			receivedCount: transfer.receivedVolumes ? transfer.receivedVolumes.size : null,
			totalVolumes: transfer.totalVolumes || null,
			resentVolumes: transfer.resentVolumes || 0,
			nackRequests: transfer.nackState ? transfer.nackState.requestSeq || 0 : 0,
			repairStatus: transfer.repairStatus || '',
		}
	}, expectedName);
}

async function runSmoke() {
	let wrangler = null;
	let browser = null;
	try {
		if (shouldStartWrangler) {
			const port = await getAvailablePort();
			baseUrl = `http://127.0.0.1:${port}/`;
			wrangler = startWrangler(port);
			await waitForWrangler(wrangler, baseUrl);
		} else {
			baseUrl = process.env.SMOKE_BASE_URL;
		}

		const executablePath = findChromeExecutable();
		browser = await chromium.launch({
			headless: true,
			...(executablePath ? { executablePath } : {}),
		});

		const aliceContext = await newEnglishContext(browser);
		const alice = await aliceContext.newPage();
		attachPageDiagnostics(alice, 'alice');
		await joinRoom(alice, 'alice');
		await sendFile(alice);
		await sendText(alice, message);
		await alice.waitForTimeout(1200);

		const bobContext = await newEnglishContext(browser);
		const bob = await bobContext.newPage();
		attachPageDiagnostics(bob, 'bob');
		await joinRoom(bob, 'bob');
		await waitForChatText(bob, message, 15000);
		await sendFile(alice);
		const bobHasLiveFile = await waitForChatText(bob, fileName, 15000);
		await dropIncomingLargeFileChunks(bob, largeFileName, largeFileDropIndices);
		await sendLargeFile(alice);
		const bobHasLargeFile = await waitForChatText(bob, largeFileName, 15000);
		const bobDroppedLargeFileChunks = await waitForDroppedChunkCount(bob, largeFileDropIndices.length);
		const bobHasCompletedLargeFile = await waitForFileTransferCompleted(bob, largeFileName);
		const bobDroppedLargeFileChunkCount = await bob.evaluate(() => (
			Array.isArray(window.__nodecryptSmokeDroppedFileVolumes) ?
				window.__nodecryptSmokeDroppedFileVolumes.length :
				0
		));
		const bobLargeTransferState = await getTransferState(bob, largeFileName);
		const aliceLargeTransferState = await getTransferState(alice, largeFileName);
		await restoreIncomingFileChunkDropper(bob);
		const bobNackRepairedLargeFile = Boolean(
			bobDroppedLargeFileChunks &&
			bobDroppedLargeFileChunkCount === largeFileDropIndices.length &&
			bobLargeTransferState &&
			bobLargeTransferState.status === 'completed' &&
			bobLargeTransferState.nackRequests > 0 &&
			aliceLargeTransferState &&
			aliceLargeTransferState.resentVolumes >= largeFileDropIndices.length
		);

		await setPrivateChat(alice, 'bob', true);
		await dropIncomingLargeFileChunks(bob, privateLargeFileName, privateLargeFileDropIndices);
		await sendLargeFile(alice, privateLargeFileName, privateLargeFilePath, 66);
		const bobHasPrivateLargeFile = await waitForChatText(bob, privateLargeFileName, 15000);
		const bobDroppedPrivateLargeFileChunks = await waitForDroppedChunkCount(bob, privateLargeFileDropIndices.length);
		const bobHasCompletedPrivateLargeFile = await waitForFileTransferCompleted(bob, privateLargeFileName);
		const bobDroppedPrivateLargeFileChunkCount = await bob.evaluate(() => (
			Array.isArray(window.__nodecryptSmokeDroppedFileVolumes) ?
				window.__nodecryptSmokeDroppedFileVolumes.length :
				0
		));
		const bobPrivateLargeTransferState = await getTransferState(bob, privateLargeFileName);
		const alicePrivateLargeTransferState = await getTransferState(alice, privateLargeFileName);
		await restoreIncomingFileChunkDropper(bob);
		const bobNackRepairedPrivateLargeFile = Boolean(
			bobHasPrivateLargeFile &&
			bobDroppedPrivateLargeFileChunks &&
			bobHasCompletedPrivateLargeFile &&
			bobDroppedPrivateLargeFileChunkCount === privateLargeFileDropIndices.length &&
			bobPrivateLargeTransferState &&
			bobPrivateLargeTransferState.status === 'completed' &&
			bobPrivateLargeTransferState.scope === 'private' &&
			bobPrivateLargeTransferState.nackRequests > 0 &&
			alicePrivateLargeTransferState &&
			alicePrivateLargeTransferState.scope === 'private' &&
			alicePrivateLargeTransferState.resentVolumes >= privateLargeFileDropIndices.length
		);
		await setPrivateChat(alice, 'bob', false);

		const danaContext = await newEnglishContext(browser);
		const dana = await danaContext.newPage();
		attachPageDiagnostics(dana, 'dana');
		await joinRoom(dana, 'dana');
		await waitForMember(alice, 'dana');
		await trackResentFileMessages(dana, multiReceiverLargeFileName);
		await dropIncomingLargeFileChunks(bob, multiReceiverLargeFileName, multiReceiverDropIndices);
		await sendLargeFile(alice, multiReceiverLargeFileName, multiReceiverLargeFilePath, 67);
		const bobDroppedMultiReceiverChunks = await waitForDroppedChunkCount(bob, multiReceiverDropIndices.length);
		const bobHasCompletedMultiReceiverLargeFile = await waitForFileTransferCompleted(bob, multiReceiverLargeFileName);
		const danaHasCompletedMultiReceiverLargeFile = await waitForFileTransferCompleted(dana, multiReceiverLargeFileName);
		const bobDroppedMultiReceiverChunkCount = await bob.evaluate(() => (
			Array.isArray(window.__nodecryptSmokeDroppedFileVolumes) ?
				window.__nodecryptSmokeDroppedFileVolumes.length :
				0
		));
		const bobMultiReceiverTransferState = await getTransferState(bob, multiReceiverLargeFileName);
		const danaMultiReceiverTransferState = await getTransferState(dana, multiReceiverLargeFileName);
		const aliceMultiReceiverTransferState = await getTransferState(alice, multiReceiverLargeFileName);
		const danaResentFileMessageCounts = await getResentFileMessageCounts(dana);
		await restoreIncomingFileChunkDropper(bob);
		await restoreIncomingFileChunkDropper(dana);
		const publicResendWasSinglecast = Boolean(
			bobHasCompletedMultiReceiverLargeFile &&
			danaHasCompletedMultiReceiverLargeFile &&
			bobDroppedMultiReceiverChunks &&
			bobDroppedMultiReceiverChunkCount === multiReceiverDropIndices.length &&
			bobMultiReceiverTransferState &&
			bobMultiReceiverTransferState.nackRequests > 0 &&
			danaMultiReceiverTransferState &&
			danaMultiReceiverTransferState.nackRequests === 0 &&
			aliceMultiReceiverTransferState &&
			aliceMultiReceiverTransferState.resentVolumes >= multiReceiverDropIndices.length &&
			danaResentFileMessageCounts.resentVolumes === 0 &&
			danaResentFileMessageCounts.resentCompletes === 0
		);

		await delayIncomingFileCompleteAfterDroppingChunks(bob, expiredLargeFileName, expiredLargeFileDropIndices);
		await sendLargeFile(alice, expiredLargeFileName, expiredLargeFilePath, 68);
		const bobHasExpiredLargeFile = await waitForChatText(bob, expiredLargeFileName, 15000);
		const bobDroppedExpiredLargeFileChunks = await waitForDroppedChunkCount(bob, expiredLargeFileDropIndices.length);
		const delayedExpiredFileComplete = await waitForDelayedFileComplete(bob);
		const aliceExpiredLargeFileSent = await waitForFileTransferCompleted(alice, expiredLargeFileName);
		const expiredSenderWindow = await expireSenderRepairWindow(alice, expiredLargeFileName);
		const releasedExpiredFileComplete = await releaseDelayedFileComplete(bob);
		const bobExpiredRepairWaitingUi = await waitForFileUiState(bob, expiredLargeFileName, 'repair-waiting', 8000);
		const bobExpiredRepairWaitingUiState = await getFileUiState(bob, expiredLargeFileName);
		const bobExpiredRepairFailedUi = await waitForFileUiState(bob, expiredLargeFileName, 'repair-failed', 10000);
		const bobExpiredRepairFailedUiState = await getFileUiState(bob, expiredLargeFileName);
		const bobExpiredRepairWaitingUiOk = isRepairWaitingUi(bobExpiredRepairWaitingUiState);
		const bobExpiredRepairFailedUiOk = isRepairFailedUi(bobExpiredRepairFailedUiState);
		const bobExpiredLargeTransferState = await getTransferState(bob, expiredLargeFileName);
		const aliceExpiredLargeTransferState = await getTransferState(alice, expiredLargeFileName);
		await restoreIncomingFileChunkDropper(bob);
		const expiredRepairWindowRejected = Boolean(
			bobHasExpiredLargeFile &&
			bobDroppedExpiredLargeFileChunks &&
			delayedExpiredFileComplete &&
			aliceExpiredLargeFileSent &&
			expiredSenderWindow &&
			releasedExpiredFileComplete &&
			bobExpiredRepairWaitingUi &&
			bobExpiredRepairWaitingUiOk &&
			bobExpiredRepairFailedUi &&
			bobExpiredRepairFailedUiOk &&
			bobExpiredLargeTransferState &&
			bobExpiredLargeTransferState.status !== 'completed' &&
			bobExpiredLargeTransferState.nackRequests > 0 &&
			bobExpiredLargeTransferState.repairStatus === 'failed' &&
			aliceExpiredLargeTransferState &&
			aliceExpiredLargeTransferState.resentVolumes === 0
		);

		await delayIncomingFileCompleteAfterDroppingChunks(bob, reconnectLargeFileName, reconnectLargeFileDropIndices);
		await sendLargeFile(alice, reconnectLargeFileName, reconnectLargeFilePath, 69);
		const bobHasReconnectLargeFile = await waitForChatText(bob, reconnectLargeFileName, 15000);
		const bobDroppedReconnectLargeFileChunks = await waitForDroppedChunkCount(bob, reconnectLargeFileDropIndices.length);
		const delayedReconnectFileComplete = await waitForDelayedFileComplete(bob);
		const reconnectSocketClose = await closeLatestSmokeSocket(bob);
		const releasedReconnectFileCompleteWhileClosed = await releaseDelayedFileComplete(bob);
		await bob.waitForTimeout(500);
		const bobReconnectUiStateAfterClosedRequest = await getFileUiState(bob, reconnectLargeFileName);
		const bobReconnectUiWaitingAfterClosedRequest = isRepairWaitingUi(bobReconnectUiStateAfterClosedRequest);
		const bobReconnectSocketReopened = await waitForLatestSmokeSocketOpen(bob, reconnectSocketClose.count + 1, 25000);
		const bobHasCompletedReconnectLargeFile = await waitForFileTransferCompleted(bob, reconnectLargeFileName, 60000);
		const bobReconnectUiRepaired = await waitForFileUiState(bob, reconnectLargeFileName, 'repaired', 10000);
		const bobReconnectUiState = await getFileUiState(bob, reconnectLargeFileName);
		const bobReconnectUiRepairedOk = isRepairedUi(bobReconnectUiState);
		const bobReconnectTransferState = await getTransferState(bob, reconnectLargeFileName);
		const aliceReconnectTransferState = await getTransferState(alice, reconnectLargeFileName);
		await restoreIncomingFileChunkDropper(bob);
		const bobReconnectRepairCompleted = Boolean(
			bobHasReconnectLargeFile &&
			bobDroppedReconnectLargeFileChunks &&
			delayedReconnectFileComplete &&
			reconnectSocketClose.closed &&
			releasedReconnectFileCompleteWhileClosed &&
			bobReconnectUiWaitingAfterClosedRequest &&
			bobReconnectSocketReopened &&
			bobHasCompletedReconnectLargeFile &&
			bobReconnectUiRepaired &&
			bobReconnectUiRepairedOk &&
			bobReconnectTransferState &&
			bobReconnectTransferState.status === 'completed' &&
			bobReconnectTransferState.nackRequests > 1 &&
			aliceReconnectTransferState &&
			aliceReconnectTransferState.resentVolumes >= reconnectLargeFileDropIndices.length
		);

		const bobText = await chatText(bob);
		const bobHasHistory = bobText.includes(message) && bobText.includes('alice');
		const bobHasLoadedNotice = bobText.includes('historical messages loaded');

		const eveContext = await newEnglishContext(browser);
		const eve = await eveContext.newPage();
		attachPageDiagnostics(eve, 'eve');
		await joinRoom(eve, 'eve', wrongPassword);

		await sendText(alice, liveMessage);
		const bobHasLiveMessage = await waitForChatText(bob, liveMessage, 15000);
		await eve.waitForTimeout(1800);
		const eveText = await chatText(eve);
		const eveIsIsolated = !eveText.includes(message) && !eveText.includes(liveMessage) && !eveText.includes('alice') && !eveText.includes('bob');
		const aliceHasUnexpectedSendFailure = await hasUnexpectedSendFailureText(alice);
		const bobHasUnexpectedSendFailure = await hasUnexpectedSendFailureText(bob);
		const danaHasUnexpectedSendFailure = await hasUnexpectedSendFailureText(dana);
		const eveHasUnexpectedSendFailure = await hasUnexpectedSendFailureText(eve);

		await eveContext.close();
		await danaContext.close();
		await bobContext.close();
		await aliceContext.close();
		await new Promise((resolve) => setTimeout(resolve, 2200));

		const charlieContext = await newEnglishContext(browser);
		const charlie = await charlieContext.newPage();
		attachPageDiagnostics(charlie, 'charlie');
		await joinRoom(charlie, 'charlie');
		await charlie.waitForTimeout(1800);
		const charlieText = await chatText(charlie);
		const charlieHasOldMessage = charlieText.includes(message);
		const charlieHasUnexpectedSendFailure = await hasUnexpectedSendFailureText(charlie);
		await charlieContext.close();

		const noUnexpectedSendFailures = !aliceHasUnexpectedSendFailure &&
			!bobHasUnexpectedSendFailure &&
			!danaHasUnexpectedSendFailure &&
			!eveHasUnexpectedSendFailure &&
			!charlieHasUnexpectedSendFailure;
		const diagnosticsClean = pageErrors.length === 0 && consoleErrors.length === 0;

		const result = {
			ok: bobHasHistory && bobHasLoadedNotice && bobHasLiveFile && bobHasLargeFile && bobHasCompletedLargeFile && bobNackRepairedLargeFile && bobNackRepairedPrivateLargeFile && publicResendWasSinglecast && expiredRepairWindowRejected && bobReconnectRepairCompleted && bobHasLiveMessage && eveIsIsolated && !charlieHasOldMessage && noUnexpectedSendFailures && diagnosticsClean,
			roomName,
			message,
			liveMessage,
			bobHasHistory,
			bobHasLoadedNotice,
			bobHasLiveFile,
			bobHasLargeFile,
			bobHasCompletedLargeFile,
			bobDroppedLargeFileChunks,
			bobDroppedLargeFileChunkCount,
			largeFileDropIndices,
			bobNackRepairedLargeFile,
			bobLargeTransferState,
			aliceLargeTransferState,
			bobHasPrivateLargeFile,
			bobHasCompletedPrivateLargeFile,
			bobDroppedPrivateLargeFileChunks,
			bobDroppedPrivateLargeFileChunkCount,
			privateLargeFileDropIndices,
			bobNackRepairedPrivateLargeFile,
			bobPrivateLargeTransferState,
			alicePrivateLargeTransferState,
			bobHasCompletedMultiReceiverLargeFile,
			danaHasCompletedMultiReceiverLargeFile,
			bobDroppedMultiReceiverChunks,
			bobDroppedMultiReceiverChunkCount,
			multiReceiverDropIndices,
			publicResendWasSinglecast,
			bobMultiReceiverTransferState,
			danaMultiReceiverTransferState,
			aliceMultiReceiverTransferState,
			danaResentFileMessageCounts,
			bobHasExpiredLargeFile,
			bobDroppedExpiredLargeFileChunks,
			delayedExpiredFileComplete,
			aliceExpiredLargeFileSent,
			expiredSenderWindow,
			releasedExpiredFileComplete,
			bobExpiredRepairWaitingUi,
			bobExpiredRepairWaitingUiState,
			bobExpiredRepairWaitingUiOk,
			bobExpiredRepairFailedUi,
			bobExpiredRepairFailedUiState,
			bobExpiredRepairFailedUiOk,
			expiredRepairWindowRejected,
			bobExpiredLargeTransferState,
			aliceExpiredLargeTransferState,
			reconnectLargeFileDropIndices,
			bobHasReconnectLargeFile,
			bobDroppedReconnectLargeFileChunks,
			delayedReconnectFileComplete,
			reconnectSocketClose,
			releasedReconnectFileCompleteWhileClosed,
			bobReconnectUiStateAfterClosedRequest,
			bobReconnectUiWaitingAfterClosedRequest,
			bobReconnectSocketReopened,
			bobHasCompletedReconnectLargeFile,
			bobReconnectUiRepaired,
			bobReconnectUiRepairedOk,
			bobReconnectRepairCompleted,
			bobReconnectTransferState,
			aliceReconnectTransferState,
			bobReconnectUiState,
			bobHasLiveMessage,
			eveIsIsolated,
			charlieHasOldMessage,
			noUnexpectedSendFailures,
			unexpectedSendFailures: {
				alice: aliceHasUnexpectedSendFailure,
				bob: bobHasUnexpectedSendFailure,
				dana: danaHasUnexpectedSendFailure,
				eve: eveHasUnexpectedSendFailure,
				charlie: charlieHasUnexpectedSendFailure,
			},
			diagnosticsClean,
			pageErrors,
			consoleErrors,
		};
		console.log(JSON.stringify(result, null, 2));
		if (!result.ok) {
			throw new Error('Cloudflare smoke test failed');
		}
	} finally {
		if (browser) {
			await browser.close();
		}
		for (const path of tempFilePaths) {
			try {
				rmSync(path);
			} catch {
				// Ignore temp-file cleanup failures.
			}
		}
		stopProcessTree(wrangler);
	}
}

runSmoke().catch((error) => {
	console.error(error);
	process.exit(1);
});
