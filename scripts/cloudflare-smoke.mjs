import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8787/';
const shouldStartWrangler = !process.env.SMOKE_BASE_URL;
const roomName = `smoke${Date.now().toString(36).slice(-8)}`;
const password = 'pw123456';
const message = `history-smoke-${Date.now()}`;
const liveMessage = `live-smoke-${Date.now()}`;

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

async function joinRoom(page, userName) {
	page.on('dialog', (dialog) => dialog.accept());
	await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#userName', { timeout: 15000 });
	await page.fill('#userName', userName);
	await page.fill('#roomName', roomName);
	await page.fill('#password', password);
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

async function runSmoke() {
	let wrangler = null;
	if (shouldStartWrangler) {
		wrangler = startWrangler();
		await waitForServer(baseUrl);
	}

	const executablePath = findChromeExecutable();
	const browser = await chromium.launch({
		headless: true,
		...(executablePath ? { executablePath } : {}),
	});

	try {
		const aliceContext = await newEnglishContext(browser);
		const alice = await aliceContext.newPage();
		await joinRoom(alice, 'alice');
		await sendText(alice, message);
		await alice.waitForTimeout(1200);

		const bobContext = await newEnglishContext(browser);
		const bob = await bobContext.newPage();
		await joinRoom(bob, 'bob');
		await waitForChatText(bob, message, 15000);

		const bobText = await chatText(bob);
		const bobHasHistory = bobText.includes(message) && bobText.includes('alice');
		const bobHasLoadedNotice = bobText.includes('historical messages loaded');
		await sendText(alice, liveMessage);
		const bobHasLiveMessage = await waitForChatText(bob, liveMessage, 15000);

		await bobContext.close();
		await aliceContext.close();
		await new Promise((resolve) => setTimeout(resolve, 2200));

		const charlieContext = await newEnglishContext(browser);
		const charlie = await charlieContext.newPage();
		await joinRoom(charlie, 'charlie');
		await charlie.waitForTimeout(1800);
		const charlieText = await chatText(charlie);
		const charlieHasOldMessage = charlieText.includes(message);
		await charlieContext.close();

		const result = {
			ok: bobHasHistory && bobHasLoadedNotice && bobHasLiveMessage && !charlieHasOldMessage,
			roomName,
			message,
			liveMessage,
			bobHasHistory,
			bobHasLoadedNotice,
			bobHasLiveMessage,
			charlieHasOldMessage,
		};
		console.log(JSON.stringify(result, null, 2));
		if (!result.ok) {
			throw new Error('Cloudflare smoke test failed');
		}
	} finally {
		await browser.close();
		stopProcessTree(wrangler);
	}
}

runSmoke().catch((error) => {
	console.error(error);
	process.exit(1);
});
