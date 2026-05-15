#!/usr/bin/env nodejs

'use strict';

const crypto = require('crypto');
const ws = require('ws');

const SEEN_TIMEOUT_MS = 60000;
const HISTORY_MAX_MESSAGES = 100;
const HISTORY_MAX_BYTES = 256 * 1024;
const HISTORY_MAX_ENTRY_BYTES = 16 * 1024;

// Generate a new RSA key pair
// 生成一个新的 RSA 密钥对
const generateRSAKeyPair = () => {
	try {
		console.log('Generating new RSA keypair...');
		const {
			publicKey,
			privateKey
		} = crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: {
				type: 'spki',
				format: 'der'
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'der'
			}
		});

		return {
			rsaPublic: Buffer.from(publicKey).toString('base64'),
			rsaPrivate: crypto.createPrivateKey({
				key: privateKey,
				format: 'der',
				type: 'pkcs8'
			})
		};
	} catch (error) {
		console.error('Error generating RSA key pair:', error);
		process.exit(1);
	}
};

const keyPair = generateRSAKeyPair();
console.log('RSA key pair generated successfully');

const config = {
	rsaPrivate: keyPair.rsaPrivate,
	rsaPublic: keyPair.rsaPublic,
	wsHost: '127.0.0.1',
	wsPort: 8088,
	seenTimeout: SEEN_TIMEOUT_MS,
	historyMaxMessages: HISTORY_MAX_MESSAGES,
	historyMaxBytes: HISTORY_MAX_BYTES,
	debug: false
};


const wss = new ws.Server({
	host: config.wsHost,
	port: config.wsPort,
	perMessageDeflate: false
});

console.log('server started', config.wsHost, config.wsPort);


var clients = {};
var channels = {};
var historyBacklogs = {};

// WebSocket server connection event handler
// WebSocket 服务器连接事件处理程序
wss.on('connection', (connection) => {

	if (
		!connection
	) {
		return;
	}


	const seenThreshold = (getTime() - config.seenTimeout);

	for (
		const clientId in clients
	) {
		if (
			clients[clientId].seen < seenThreshold
		) {
			try {
				logEvent('connection-seen', clientId, 'debug');
				clients[clientId].connection.terminate();
			} catch (error) {
				logEvent('connection-seen', error, 'error');
			}
		}
	}


	const clientId = generateClientId();

	if (
		!clientId ||
		clients[clientId]
	) {
		closeConnection(connection);
		return;
	}

	logEvent('connection', clientId, 'debug');


	clients[clientId] = {
		connection: connection,
		seen: getTime(),
		key: null,
		channel: null
	};

	try {
		logEvent('sending-public-key', clientId, 'debug');
		sendMessage(connection, JSON.stringify({
			type: 'server-key',
			key: config.rsaPublic
		}));
	} catch (error) {
		logEvent('sending-public-key', error, 'error');
	}



	connection.on('message', (message) => {

		if (
			!isString(message) ||
			!clients[clientId]
		) {
			return;
		}

		clients[clientId].seen = getTime();

		if (
			message === 'ping'
		) {
			sendMessage(connection, 'pong');
			return;
		}

		logEvent('message', [clientId, message], 'debug');

		if (
			!clients[clientId].shared &&
			message.length < 2048
		) {


			try {

				const keys = crypto.createECDH('secp384r1');

				keys.generateKeys();

				const publicKey = keys.getPublicKey();
				const signature = crypto.sign('sha256', publicKey, {
					key: config.rsaPrivate,
					padding: crypto.constants.RSA_PKCS1_PADDING,
					dsaEncoding: 'ieee-p1363'
				});

				clients[clientId].shared = keys.computeSecret(message, 'hex', null).slice(8, 40);

				sendMessage(connection, publicKey.toString('hex') + '|' + signature.toString('base64'));

			} catch (error) {
				logEvent('message-key', [clientId, error], 'error');
				closeConnection(connection);
			}

			return;

		}

		if (
			clients[clientId].shared &&
			message.length <= (8 * 1024 * 1024)
		) {

			processEncryptedMessage(clientId, message);

		}

	});



	connection.on('close', (event) => {

		logEvent('close', [clientId, event], 'debug');

		const client = clients[clientId];

		if (!client) {
			return;
		}

		removeClientFromChannel(clientId, client.channel);

		if (
			clients[clientId]
		) {
			delete(clients[clientId]);
		}

	});

});

// Process encrypted messages
// 处理加密消息
const processEncryptedMessage = (clientId, message) => {
	let decrypted = null;

	try {
		decrypted = decryptMessage(message, clients[clientId].shared);

		logEvent('message-decrypted', [clientId, decrypted], 'debug');

		if (
			!isObject(decrypted) ||
			!isString(decrypted.a)
		) {
			return;
		}

		const action = decrypted.a;

		if (action === 'j') {
			handleJoinChannel(clientId, decrypted);
		} else if (action === 'c') {
			handleClientMessage(clientId, decrypted);
		} else if (action === 'w') {
			handleChannelMessage(clientId, decrypted);
		} else if (action === 'h') {
			handleHistoryMessage(clientId, decrypted);
		}

	} catch (error) {
		logEvent('process-encrypted-message', [clientId, error], 'error');
	} finally {
		decrypted = null;
	}
};

// Handle channel join requests
// 处理加入频道请求
const handleJoinChannel = (clientId, decrypted) => {
	if (
		!isString(decrypted.p) ||
		clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = decrypted.p;

		clients[clientId].channel = channel;

		if (!channels[channel]) {
			channels[channel] = [clientId];
		} else {
			channels[channel].push(clientId);
		}

		sendHistoryBacklog(clientId, channel);
		broadcastMemberList(channel);

	} catch (error) {
		logEvent('message-join', [clientId, error], 'error');
	}
};

// Handle encrypted temporary room history.
// 处理临时房间历史密文。
const handleHistoryMessage = (clientId, decrypted) => {
	if (
		!isString(decrypted.p) ||
		!clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = clients[clientId].channel;
		appendHistoryEntry(channel, decrypted.p);
	} catch (error) {
		logEvent('message-history', [clientId, error], 'error');
	}
};

// Handle client messages
// 处理客户端消息
const handleClientMessage = (clientId, decrypted) => {
	if (
		!isString(decrypted.p) ||
		!isString(decrypted.c) ||
		!clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = clients[clientId].channel;
		const targetClient = clients[decrypted.c];

		if (isClientInChannel(targetClient, channel)) {
			const messageObj = {
				a: 'c',
				p: decrypted.p,
				c: clientId
			};

			const encrypted = encryptMessage(messageObj, targetClient.shared);
			sendMessage(targetClient.connection, encrypted);

			messageObj.p = null;
		}

	} catch (error) {
		logEvent('message-client', [clientId, error], 'error');
	}
};

// Handle channel messages
// 处理频道消息
const handleChannelMessage = (clientId, decrypted) => {
	if (
		!isObject(decrypted.p) ||
		!clients[clientId].channel
	) {
		return;
	}

	try {
		const channel = clients[clientId].channel;

		for (const member in decrypted.p) {
			const targetClient = clients[member];

			if (
				isString(decrypted.p[member]) &&
				isClientInChannel(targetClient, channel)
			) {
				const messageObj = {
					a: 'c',
					p: decrypted.p[member],
					c: clientId
				};

				const encrypted = encryptMessage(messageObj, targetClient.shared);
				sendMessage(targetClient.connection, encrypted);

				messageObj.p = null;
			}
		}

	} catch (error) {
		logEvent('message-channel', [clientId, error], 'error');
	}
};

// Broadcast member list to channel
// 向频道广播成员列表
const broadcastMemberList = (channel) => {
	try {
		const members = channels[channel];

		for (const member of members) {
			const client = clients[member];

			if (isClientInChannel(client, channel)) {
				const filteredMembers = members.filter(value => value !== member);

				const listObj = {
					a: 'l',
					p: filteredMembers
				};

				const encrypted = encryptMessage(listObj, client.shared);
				sendMessage(client.connection, encrypted);

				listObj.p = null;
			}
		}
	} catch (error) {
		logEvent('broadcast-member-list', error, 'error');
	}
};

const appendHistoryEntry = (channel, encryptedHistory) => {
	if (!channel || !isString(encryptedHistory) || encryptedHistory.length > HISTORY_MAX_ENTRY_BYTES) {
		return;
	}

	if (!historyBacklogs[channel]) {
		historyBacklogs[channel] = [];
	}

	const backlog = historyBacklogs[channel];
	backlog.push(encryptedHistory);

	while (backlog.length > config.historyMaxMessages) {
		backlog.shift();
	}

	let totalBytes = backlog.reduce((sum, item) => sum + item.length, 0);
	while (totalBytes > config.historyMaxBytes && backlog.length > 0) {
		const removed = backlog.shift();
		totalBytes -= removed ? removed.length : 0;
	}
};

const sendHistoryBacklog = (clientId, channel) => {
	try {
		const client = clients[clientId];
		const backlog = historyBacklogs[channel];

		if (!isClientInChannel(client, channel) || !backlog || backlog.length === 0) {
			return;
		}

		const encrypted = encryptMessage({
			a: 'h',
			p: backlog
		}, client.shared);
		sendMessage(client.connection, encrypted);
	} catch (error) {
		logEvent('history-backlog', [clientId, error], 'error');
	}
};

const removeClientFromChannel = (clientId, channel, notifyMembers = true) => {
	if (!channel || !channels[channel]) {
		return;
	}

	const index = channels[channel].indexOf(clientId);
	if (index >= 0) {
		channels[channel].splice(index, 1);
	}

	if (channels[channel].length === 0) {
		delete(channels[channel]);
		delete(historyBacklogs[channel]);
		return;
	}

	if (notifyMembers) {
		broadcastMemberList(channel);
	}
};



// Log events with timestamps and levels
// 记录带时间戳和级别的事件
const logEvent = (source, message, level) => {
	if (
		level !== 'debug' ||
		config.debug
	) {

		const date = new Date(),
			dateString = date.getFullYear() + '-' +
			('0' + (date.getMonth() + 1)).slice(-2) + '-' +
			('0' + date.getDate()).slice(-2) + ' ' +
			('0' + date.getHours()).slice(-2) + ':' +
			('0' + date.getMinutes()).slice(-2) + ':' +
			('0' + date.getSeconds()).slice(-2);

		console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''));

	}
};


const generateClientId = () => {
	try {
		return (crypto.randomBytes(8).toString('hex'));
	} catch (error) {
		logEvent('generateClientId', error, 'error');
		return (null);
	}
};


const closeConnection = (connection) => {
	try {
		connection.close();
	} catch (error) {
		logEvent('closeConnection', error, 'error');
	}
};


const isClientInChannel = (client, channel) => {
	return (
		client &&
		client.connection &&
		client.shared &&
		client.channel &&
		client.channel === channel ?
		true :
		false
	);
};


const sendMessage = (connection, message) => {
	try {
		if (
			connection.readyState &&
			connection.readyState === ws.OPEN
		) {
			connection.send(message);
		}
	} catch (error) {
		logEvent('sendMessage', error, 'error');
	}
};


const encryptMessage = (message, key) => {

	let encrypted = '';

	try {

		const messageBuffer = Buffer.from(JSON.stringify(message), 'utf8');

		const paddedBuffer = (messageBuffer.length % 16) !== 0 ?
			Buffer.concat([messageBuffer, Buffer.alloc(16 - (messageBuffer.length % 16))]) :
			messageBuffer;

		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
		cipher.setAutoPadding(false);

		encrypted = iv.toString('base64') + '|' + cipher.update(paddedBuffer, '', 'base64') + cipher.final('base64');

	} catch (error) {
		logEvent('encryptMessage', error, 'error');
	}

	return (encrypted);

};


const decryptMessage = (message, key) => {

	let decrypted = {};

	try {

		const parts = message.split('|');
		const decipher = crypto.createDecipheriv(
			'aes-256-cbc',
			key,
			Buffer.from(parts[0], 'base64')
		);

		decipher.setAutoPadding(false);

		const decryptedText = decipher.update(parts[1], 'base64', 'utf8') + decipher.final('utf8');
		decrypted = JSON.parse(decryptedText.replace(/\0+$/, ''));

	} catch (error) {
		logEvent('decryptMessage', error, 'error');
	}

	return (decrypted);

};


const getTime = () => {
	return (new Date().getTime());
};


const isString = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object String]' ?
		true :
		false
	);
};


const isArray = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object Array]' ?
		true :
		false
	);
};


const isObject = (value) => {
	return (
		value &&
		Object.prototype.toString.call(value) === '[object Object]' ?
		true :
		false
	);
};

setInterval(() => {
	if (global.gc) {
		global.gc();
	}
}, 30000);
