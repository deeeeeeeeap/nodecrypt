import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787/';
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
const largeFileDropIndices = [3, 4, 8];
const privateLargeFileDropIndices = [2, 5];
const multiReceiverDropIndices = [6, 7];
const expiredLargeFileDropIndices = [4];
const tempFilePaths = [
	filePath,
	largeFilePath,
	privateLargeFilePath,
	multiReceiverLargeFilePath,
	expiredLargeFilePath,
];

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

function startWrangler() {
	const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
	const args = process.platform === 'win32' ?
		['/d', '/s', '/c', 'npx wrangler dev --ip 127.0.0.1 --port 8787'] :
		['wrangler', 'dev', '--ip', '127.0.0.1', '--port', '8787'];
	const child = spawn(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: false,
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
	});
	return context;
}

function attachPageDiagnostics(page, name) {
	page.on('pageerror', (error) => {
		console.error(`[${name}] pageerror: ${error.message}`);
	});
	page.on('console', (message) => {
		if (message.type() === 'error') {
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
				if (!window.__nodecryptSmokeDelayedFileComplete) {
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
			wrangler = startWrangler();
			await waitForServer(baseUrl);
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
		await bob.waitForTimeout(5000);
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
			bobExpiredLargeTransferState &&
			bobExpiredLargeTransferState.status !== 'completed' &&
			bobExpiredLargeTransferState.nackRequests > 0 &&
			aliceExpiredLargeTransferState &&
			aliceExpiredLargeTransferState.resentVolumes === 0
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
		await charlieContext.close();

		const result = {
			ok: bobHasHistory && bobHasLoadedNotice && bobHasLiveFile && bobHasLargeFile && bobHasCompletedLargeFile && bobNackRepairedLargeFile && bobNackRepairedPrivateLargeFile && publicResendWasSinglecast && expiredRepairWindowRejected && bobHasLiveMessage && eveIsIsolated && !charlieHasOldMessage,
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
			expiredRepairWindowRejected,
			bobExpiredLargeTransferState,
			aliceExpiredLargeTransferState,
			bobHasLiveMessage,
			eveIsIsolated,
			charlieHasOldMessage,
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
