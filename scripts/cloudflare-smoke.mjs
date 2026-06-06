import { spawn } from 'node:child_process';
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
		spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
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
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
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

async function sendLargeFile(page) {
	writeFileSync(largeFilePath, Buffer.alloc(9 * 1024 * 1024, 65));
	await page.locator('.chat-attach-btn').click();
	await page.setInputFiles('#file-upload-input', largeFilePath);
	await page.locator('.file-upload-send-btn').click();
	if (!(await waitForChatText(page, largeFileName, 15000))) {
		throw new Error(`Sent large file did not render: ${largeFileName}`);
	}
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

async function dropOneIncomingLargeFileChunk(page, expectedName, volumeIndex = 3) {
	await page.evaluate(({ fileNameToDrop, volumeIndexToDrop }) => {
		window.__nodecryptSmokeDropFileId = null;
		window.__nodecryptSmokeDroppedFileVolume = false;
		const originalHandleFileMessage = window.handleFileMessage;
		window.handleFileMessage = function patchedHandleFileMessage(message, ...args) {
			if (message && message.type === 'file_start' && message.fileName === fileNameToDrop) {
				window.__nodecryptSmokeDropFileId = message.fileId;
			}
			if (message && message.type === 'file_complete' && message.fileId === window.__nodecryptSmokeDropFileId) {
				if (!window.__nodecryptSmokeDroppedFileVolume) {
					const transfer = window.fileTransfers && window.fileTransfers.get(message.fileId);
					if (transfer && transfer.receivedVolumes) {
						transfer.receivedVolumes.delete(volumeIndexToDrop);
						if (Array.isArray(transfer.volumeData)) {
							transfer.volumeData[volumeIndexToDrop] = undefined;
						}
						if (transfer.status === 'completed') {
							transfer.status = 'receiving';
						}
					}
					window.__nodecryptSmokeDroppedFileVolume = true;
				}
			}
			return originalHandleFileMessage.call(window, message, ...args)
		}
	}, { fileNameToDrop: expectedName, volumeIndexToDrop: volumeIndex });
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
		await dropOneIncomingLargeFileChunk(bob, largeFileName);
		await sendLargeFile(alice);
		const bobHasLargeFile = await waitForChatText(bob, largeFileName, 15000);
		const bobHasCompletedLargeFile = await waitForFileTransferCompleted(bob, largeFileName);
		const bobDroppedLargeFileChunk = await bob.evaluate(() => window.__nodecryptSmokeDroppedFileVolume === true);
		const bobLargeTransferState = await getTransferState(bob, largeFileName);
		const aliceLargeTransferState = await getTransferState(alice, largeFileName);
		const bobNackRepairedLargeFile = Boolean(
			bobDroppedLargeFileChunk &&
			bobLargeTransferState &&
			bobLargeTransferState.status === 'completed' &&
			bobLargeTransferState.nackRequests > 0 &&
			aliceLargeTransferState &&
			aliceLargeTransferState.resentVolumes > 0
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
			ok: bobHasHistory && bobHasLoadedNotice && bobHasLiveFile && bobHasLargeFile && bobHasCompletedLargeFile && bobNackRepairedLargeFile && bobHasLiveMessage && eveIsIsolated && !charlieHasOldMessage,
			roomName,
			message,
			liveMessage,
			bobHasHistory,
			bobHasLoadedNotice,
			bobHasLiveFile,
			bobHasLargeFile,
			bobHasCompletedLargeFile,
			bobDroppedLargeFileChunk,
			bobNackRepairedLargeFile,
			bobLargeTransferState,
			aliceLargeTransferState,
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
		try {
			rmSync(filePath);
		} catch {
			// Ignore temp-file cleanup failures.
		}
		try {
			rmSync(largeFilePath);
		} catch {
			// Ignore temp-file cleanup failures.
		}
		stopProcessTree(wrangler);
	}
}

runSmoke().catch((error) => {
	console.error(error);
	process.exit(1);
});
