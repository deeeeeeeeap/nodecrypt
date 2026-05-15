// NodeCrypt core cryptographic client for secure chat
// NodeCrypt 安全聊天的核心加密客户端

import {
	sha256
} from 'js-sha256';
import {
	ModeOfOperation
} from 'aes-js';
import {
	Buffer
} from 'buffer';
window.Buffer = Buffer;

// Main NodeCrypt class for secure communication
// 用于安全通信的 NodeCrypt 主类
class NodeCrypt {
	// Initialize NodeCrypt instance
	// 初始化 NodeCrypt 实例
	constructor(config = {}, callbacks = {}) {
		this.config = {
			rsaPublic: config.rsaPublic || '',
			wsAddress: config.wsAddress || '',
			reconnectDelay: config.reconnectDelay || 3000,
			pingInterval: config.pingInterval || 20000,
			debug: config.debug || false,
		};
		this.callbacks = {
			onServerClosed: callbacks.onServerClosed || null,
			onServerSecured: callbacks.onServerSecured || null,
			onServerKeyChanged: callbacks.onServerKeyChanged || null,
			onServerTrustError: callbacks.onServerTrustError || null,
			onClientSecured: callbacks.onClientSecured || null,
			onClientList: callbacks.onClientList || null,
			onClientMessage: callbacks.onClientMessage || null,
			onHistoryMessages: callbacks.onHistoryMessages || null,
		};
		this.SERVER_KEY_STORAGE = 'nodecrypt_server_key';
		this.serverKeys = null;
		this.serverShared = null;
		this.historyKey = null;
		this.credentials = null;
		this.connection = null;
		this.reconnect = null;
		this.ping = null;
		this.channel = {};
		this.setCredentials = this.setCredentials.bind(this);
		this.connect = this.connect.bind(this);
		this.destruct = this.destruct.bind(this);
		this.getWebSocketAddress = this.getWebSocketAddress.bind(this);
		this.getServerKeyStorageKey = this.getServerKeyStorageKey.bind(this);
		this.onOpen = this.onOpen.bind(this);
		this.onMessage = this.onMessage.bind(this);
		this.onError = this.onError.bind(this);
		this.onClose = this.onClose.bind(this);
		this.logEvent = this.logEvent.bind(this);
		this.isOpen = this.isOpen.bind(this);
		this.isClosed = this.isClosed.bind(this);
		this.startReconnect = this.startReconnect.bind(this);
		this.stopReconnect = this.stopReconnect.bind(this);
		this.startPing = this.startPing.bind(this);
		this.stopPing = this.stopPing.bind(this);
		this.disconnect = this.disconnect.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendChannelMessage = this.sendChannelMessage.bind(this);
		this.storeHistoryMessage = this.storeHistoryMessage.bind(this);
		this.encryptHistoryMessage = this.encryptHistoryMessage.bind(this);
		this.decryptHistoryMessage = this.decryptHistoryMessage.bind(this);
		this.getHistoryKey = this.getHistoryKey.bind(this);
		this.createClientChannel = this.createClientChannel.bind(this);
		this.deriveClientSharedKey = this.deriveClientSharedKey.bind(this);
		this.encryptServerMessage = this.encryptServerMessage.bind(this);
		this.decryptServerMessage = this.decryptServerMessage.bind(this);
		this.encryptClientMessage = this.encryptClientMessage.bind(this);
		this.decryptClientMessage = this.decryptClientMessage.bind(this)
	}

	// Set user credentials (username, channel, password)
	// 设置用户凭证（用户名、频道、密码）
	setCredentials(username, channel, password) {
		this.logEvent('setCredentials');
		try {
			this.credentials = {
				username: username,
				channel: sha256(channel),
				password: sha256(password)
			};
			this.historyKey = null
		} catch (error) {
			this.logEvent('setCredentials', error, 'error');
			return (false)
		}
		return (true)
	}

	// Connect to the server
	// 连接到服务器
	connect() {
		if (!this.credentials) {
			return (false)
		}
		const wsAddress = this.getWebSocketAddress();
		this.logEvent('connect', wsAddress);
		this.stopReconnect();
		this.stopPing();
		this.serverKeys = null;
		this.serverShared = null;
		this.historyKey = null;
		this.channel = {};
		try {
			this.connection = new WebSocket(wsAddress);
			this.connection.onopen = this.onOpen;
			this.connection.onmessage = this.onMessage;
			this.connection.onerror = this.onError;
			this.connection.onclose = this.onClose
		} catch (error) {
			this.logEvent('connect', error, 'error');
			return (false)
		}
		return (true)
	}

	// Include the room hash in the WebSocket URL so Workers can shard by room.
	// 在 WebSocket URL 中附加房间哈希，便于 Workers 按房间分片。
	getWebSocketAddress() {
		try {
			const url = new URL(this.config.wsAddress, window.location.href);
			if (this.credentials && this.credentials.channel) {
				url.searchParams.set('room', this.credentials.channel)
			}
			return url.toString()
		} catch (error) {
			this.logEvent('getWebSocketAddress', error, 'error');
			return this.config.wsAddress
		}
	}

	// Scope pinned server keys by endpoint and room hash; Workers shard rooms into distinct Durable Objects.
	// 按端点和房间哈希隔离服务端公钥指纹；Workers 会将房间分片到不同 Durable Object。
	getServerKeyStorageKey() {
		try {
			const url = new URL(this.config.wsAddress, window.location.href);
			const roomScope = this.credentials && this.credentials.channel ?
				`:${this.credentials.channel}` :
				'';
			return `${this.SERVER_KEY_STORAGE}:${url.protocol}//${url.host}${roomScope}`
		} catch (error) {
			this.logEvent('getServerKeyStorageKey', error, 'error');
			return this.SERVER_KEY_STORAGE
		}
	}

	// Clean up and disconnect
	// 清理并断开连接
	destruct() {
		this.logEvent('destruct');
		this.stopReconnect();
		this.stopPing();
		this.reconnect = null;
		this.ping = null;
		this.config = {
			rsaPublic: '',
			wsAddress: '',
			reconnectDelay: 3000,
			pingInterval: 15000,
			debug: false,
		};
		this.callbacks.onServerClosed = null;
		this.callbacks.onServerSecured = null;
		this.callbacks.onServerKeyChanged = null;
		this.callbacks.onServerTrustError = null;
		this.callbacks.onClientSecured = null;
		this.callbacks.onClientList = null;
		this.callbacks.onClientMessage = null;
		this.callbacks.onHistoryMessages = null;
		this.serverKeys = null;
		this.serverShared = null;
		this.historyKey = null;
		this.credentials = null;
		if (this.connection) {
			this.connection.onopen = null;
			this.connection.onmessage = null;
			this.connection.onerror = null;
			this.connection.onclose = null;
			try {
				this.connection.close()
			} catch (error) {
				this.logEvent('destruct', error, 'error')
			}
		}
		this.connection = null;
		this.channel = {};
		return (true)
	}

	// WebSocket open event handler
	// WebSocket 连接打开事件处理
	async onOpen() {
		this.logEvent('onOpen');
		this.startPing();
		try {
			this.serverKeys = await crypto.subtle.generateKey({
				name: 'ECDH',
				namedCurve: 'P-384'
			}, false, ['deriveKey', 'deriveBits']);
			this.serverShared = null;
			this.sendMessage(Buffer.from(await crypto.subtle.exportKey('raw', this.serverKeys.publicKey)).toString('hex'))
		} catch (error) {
			this.logEvent('onOpen', error, 'error')
		}
	}

	// WebSocket message event handler
	// WebSocket 消息事件处理
	async onMessage(event) {
		if (!event || !this.isString(event.data)) {
			return
		}
		if (event.data === 'pong') {
			return
		}
		this.logEvent('onMessage', event.data);
		try {
			const data = JSON.parse(event.data);
			if (data.type === 'server-key') {
				const result = await this.handleServerKey(data.key);
				if (!result) {
					return
				}
			}
		} catch (e) {}
		if (!this.serverShared) {
			const parts = event.data.split('|');
			if (!parts[0] || !parts[1]) {
				return
			}
			try {
				if (await crypto.subtle.verify({
						name: 'RSASSA-PKCS1-v1_5'
					}, await crypto.subtle.importKey('spki', Buffer.from(this.config.rsaPublic, 'base64'), {
						name: 'RSASSA-PKCS1-v1_5',
						hash: {
							name: 'SHA-256'
						}
					}, false, ['verify']), Buffer.from(parts[1], 'base64'), Buffer.from(parts[0], 'hex')) === true) {
					this.serverShared = Buffer.from(await crypto.subtle.deriveBits({
						name: 'ECDH',
						namedCurve: 'P-384',
						public: await crypto.subtle.importKey('raw', Buffer.from(parts[0], 'hex'), {
							name: 'ECDH',
							namedCurve: 'P-384'
						}, true, [])
					}, this.serverKeys.privateKey, 384)).slice(8, 40);
					this.sendMessage(this.encryptServerMessage({
						a: 'j',
						p: this.credentials.channel
					}, this.serverShared));
					if (this.callbacks.onServerSecured) {
						try {
							this.callbacks.onServerSecured()
						} catch (error) {
							this.logEvent('onMessage-server-secured-callback', error, 'error')
						}
					}
				}
			} catch (error) {
				this.logEvent('onMessage', error, 'error')
			}
			return
		}
		const serverDecrypted = this.decryptServerMessage(event.data, this.serverShared);
		this.logEvent('onMessage-server-decrypted', serverDecrypted);
		if (!this.isObject(serverDecrypted) || !this.isString(serverDecrypted.a)) {
			return
		}
		if (serverDecrypted.a === 'l' && this.isArray(serverDecrypted.p)) {
			try {
				for (const clientId in this.channel) {
					if (serverDecrypted.p.indexOf(clientId) < 0) {
						delete(this.channel[clientId])
					}
				}
				let payloads = {};
				for (const clientId of serverDecrypted.p) {
					if (!this.channel[clientId]) {
						this.channel[clientId] = await this.createClientChannel();
						payloads[clientId] = this.channel[clientId].publicKey
					}
				}
				if (Object.keys(payloads).length > 0) {
					this.sendMessage(this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared))
				}
			} catch (error) {
				this.logEvent('onMessage-list', error, 'error')
			}
			if (this.callbacks.onClientList) {
				let clients = [];
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						clients.push({
							clientId: clientId,
							username: this.channel[clientId].username
						})
					}
				}
				try {
					this.callbacks.onClientList(clients)
				} catch (error) {
					this.logEvent('onMessage-client-list-callback', error, 'error')
				}
			}
			return
		}
		if (serverDecrypted.a === 'h' && this.isArray(serverDecrypted.p)) {
			try {
				const historyMessages = [];
				for (const encryptedHistory of serverDecrypted.p) {
					const historyMessage = await this.decryptHistoryMessage(encryptedHistory);
					if (historyMessage) {
						historyMessages.push(historyMessage)
					}
				}
				if (historyMessages.length > 0 && this.callbacks.onHistoryMessages) {
					this.callbacks.onHistoryMessages(historyMessages)
				}
			} catch (error) {
				this.logEvent('onMessage-history', error, 'error')
			}
			return
		}
		if (!this.isString(serverDecrypted.p) || !this.isString(serverDecrypted.c)) {
			return
		}
		if (serverDecrypted.a === 'c' && (!this.channel[serverDecrypted.c] || !this.channel[serverDecrypted.c].shared)) {
			try {
				if (!this.channel[serverDecrypted.c]) {
					this.channel[serverDecrypted.c] = await this.createClientChannel();
					this.sendMessage(this.encryptServerMessage({
						a: 'c',
						p: this.channel[serverDecrypted.c].publicKey,
						c: serverDecrypted.c
					}, this.serverShared))
				}
				this.channel[serverDecrypted.c].shared = await this.deriveClientSharedKey(this.channel[serverDecrypted.c], serverDecrypted.p);
				this.sendMessage(this.encryptServerMessage({
					a: 'c',
					p: await this.encryptClientMessage({
						a: 'u',
						p: this.credentials.username
					}, this.channel[serverDecrypted.c].shared),
					c: serverDecrypted.c
				}, this.serverShared))
			} catch (error) {
				this.logEvent('onMessage-client', error, 'error')
			}
			return
		}
		if (serverDecrypted.a === 'c' && this.channel[serverDecrypted.c] && this.channel[serverDecrypted.c].shared) {
			const clientDecrypted = await this.decryptClientMessage(serverDecrypted.p, this.channel[serverDecrypted.c].shared);
			this.logEvent('onMessage-client-decrypted', clientDecrypted);
			if (!this.isObject(clientDecrypted) || !this.isString(clientDecrypted.a)) {
				return
			}
			if (clientDecrypted.a === 'u' && this.isString(clientDecrypted.p) && clientDecrypted.p.match(/\S+/) && !this.channel[serverDecrypted.c].username) {
				this.channel[serverDecrypted.c].username = clientDecrypted.p.replace(/^\s+/, '').replace(/\s+$/, '');
				if (this.callbacks.onClientSecured) {
					try {
						this.callbacks.onClientSecured({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username
						})
					} catch (error) {
						this.logEvent('onMessage-client-secured-callback', error, 'error')
					}
				}
				return
			}			if (!this.channel[serverDecrypted.c].username) {
				return
			}
			if (clientDecrypted.a === 'm' && this.isString(clientDecrypted.t) && (this.isString(clientDecrypted.d) || this.isObject(clientDecrypted.d))) {
				if (this.callbacks.onClientMessage) {
					try {
						this.callbacks.onClientMessage({
							clientId: serverDecrypted.c,
							username: this.channel[serverDecrypted.c].username,
							type: clientDecrypted.t,
							data: clientDecrypted.d
						})
					} catch (error) {
						this.logEvent('onMessage-client-message-callback', error, 'error')
					}
				}
				return
			}
		}
	}

	// WebSocket error event handler
	// WebSocket 错误事件处理
	async onError(event) {
		this.logEvent('onError', event, 'error');
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onError-server-closed-callback', error, 'error')
			}
		}
	}

	// WebSocket close event handler
	// WebSocket 关闭事件处理
	async onClose(event) {
		this.logEvent('onClose', event);
		this.disconnect();
		if (this.credentials) {
			this.startReconnect()
		}
		if (this.callbacks.onServerClosed) {
			try {
				this.callbacks.onServerClosed()
			} catch (error) {
				this.logEvent('onClose-server-closed-callback', error, 'error')
			}
		}
	}

	// Log events for debugging
	// 记录事件日志用于调试
	logEvent(source, message, level) {
		if (this.config.debug) {
			const date = new Date(),
				dateString = date.getFullYear() + '-' + ('0' + (date.getMonth() + 1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + ' ' + ('0' + date.getHours()).slice(-2) + ':' + ('0' + date.getMinutes()).slice(-2) + ':' + ('0' + date.getSeconds()).slice(-2);
			console.log('[' + dateString + ']', (level ? level.toUpperCase() : 'INFO'), source + (message ? ':' : ''), (message ? message : ''))
		}
	}

	// Check if connection is open
	// 检查连接是否已打开
	isOpen() {
		return (this.connection && this.connection.readyState && this.connection.readyState === WebSocket.OPEN ? true : false)
	}

	// Check if connection is closed
	// 检查连接是否已关闭
	isClosed() {
		return (!this.connection || !this.connection.readyState || this.connection.readyState === WebSocket.CLOSED ? true : false)
	}

	// Start reconnect timer
	// 启动重连定时器
	startReconnect() {
		this.stopReconnect();
		this.logEvent('startReconnect');
		this.reconnect = setTimeout(() => {
			this.reconnect = null;
			this.connect()
		}, this.config.reconnectDelay)
	}

	// Stop reconnect timer
	// 停止重连定时器
	stopReconnect() {
		if (this.reconnect) {
			this.logEvent('stopReconnect');
			clearTimeout(this.reconnect);
			this.reconnect = null
		}
	}

	// Start ping timer
	// 启动心跳定时器
	startPing() {
		this.stopPing();
		this.logEvent('startPing');
		this.ping = setInterval(() => {
			this.sendMessage('ping')
		}, this.config.pingInterval)
	}

	// Stop ping timer
	// 停止心跳定时器
	stopPing() {
		if (this.ping) {
			this.logEvent('stopPing');
			clearInterval(this.ping);
			this.ping = null
		}
	}

	// Disconnect from server
	// 从服务器断开连接
	disconnect() {
		this.stopReconnect();
		this.stopPing();
		if (!this.isClosed()) {
			try {
				this.logEvent('disconnect');
				this.connection.close()
			} catch (error) {
				this.logEvent('disconnect', error, 'error')
			}
		}
	}

	// Send a message to the server
	// 向服务器发送消息
	sendMessage(message) {
		try {
			if (this.isOpen()) {
				this.connection.send(message);
				return (true)
			}
		} catch (error) {
			this.logEvent('sendMessage', error, 'error')
		}
		return (false)
	}

	// Send a message to all channels
	// 向所有频道发送消息
	async sendChannelMessage(type, data) {
		if (this.serverShared) {
			try {
				let payloads = {};
				for (const clientId in this.channel) {
					if (this.channel[clientId].shared && this.channel[clientId].username) {
						payloads[clientId] = await this.encryptClientMessage({
							a: 'm',
							t: type,
							d: data
						}, this.channel[clientId].shared);
						if (payloads[clientId].length === 0) {
							return (false)
						}
					}
				}
				if (Object.keys(payloads).length > 0) {
					const payload = this.encryptServerMessage({
						a: 'w',
						p: payloads,
					}, this.serverShared);
					if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
						return (false)
					}
					this.connection.send(payload)
				}
				if (type === 'text' && this.isString(data)) {
					this.storeHistoryMessage(type, data)
				}
				return (true)
			} catch (error) {
				this.logEvent('sendChannelMessage', error, 'error')
			}
		}
		return (false)
	}

	// Store text-only public history as room-password encrypted ciphertext on the relay.
	// 仅将公共文本历史以房间密码派生密钥加密后缓存到中继端。
	async storeHistoryMessage(type, data) {
		try {
			if (!this.serverShared || type !== 'text' || !this.isString(data)) {
				return (false)
			}

			const encryptedHistory = await this.encryptHistoryMessage(type, data);
			if (!encryptedHistory) {
				return (false)
			}

			const payload = this.encryptServerMessage({
				a: 'h',
				p: encryptedHistory
			}, this.serverShared);

			if (!this.isOpen() || payload.length === 0 || payload.length > (8 * 1024 * 1024)) {
				return (false)
			}

			this.connection.send(payload);
			return (true)
		} catch (error) {
			this.logEvent('storeHistoryMessage', error, 'error')
		}
		return (false)
	}

	async getHistoryKey() {
		if (this.historyKey) {
			return this.historyKey
		}
		if (!this.credentials) {
			return null
		}

		const keyHex = sha256(`nodecrypt-history-v1|${this.credentials.channel}|${this.credentials.password}`);
		this.historyKey = await crypto.subtle.importKey(
			'raw',
			Buffer.from(keyHex, 'hex'),
			{
				name: 'AES-GCM'
			},
			false,
			['encrypt', 'decrypt']
		);
		return this.historyKey
	}

	async encryptHistoryMessage(type, data) {
		try {
			const historyKey = await this.getHistoryKey();
			if (!historyKey) {
				return ''
			}

			const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const entry = {
				v: 1,
				id: crypto.randomUUID ? crypto.randomUUID() : Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
				u: this.credentials.username,
				t: type,
				d: data,
				ts: Date.now()
			};
			const encrypted = await crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv: nonce
				},
				historyKey,
				Buffer.from(JSON.stringify(entry), 'utf8')
			);

			return `h1|${nonce.toString('base64')}|${Buffer.from(encrypted).toString('base64')}`
		} catch (error) {
			this.logEvent('encryptHistoryMessage', error, 'error')
		}
		return ''
	}

	async decryptHistoryMessage(message) {
		try {
			if (!this.isString(message)) {
				return null
			}

			const parts = message.split('|');
			if (parts.length !== 3 || parts[0] !== 'h1') {
				return null
			}

			const historyKey = await this.getHistoryKey();
			if (!historyKey) {
				return null
			}

			const decrypted = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: Buffer.from(parts[1], 'base64')
				},
				historyKey,
				Buffer.from(parts[2], 'base64')
			);
			const entry = JSON.parse(Buffer.from(decrypted).toString('utf8'));
			if (
				!entry ||
				entry.v !== 1 ||
				!this.isString(entry.id) ||
				!this.isString(entry.u) ||
				entry.t !== 'text' ||
				!this.isString(entry.d) ||
				typeof entry.ts !== 'number'
			) {
				return null
			}
			return entry
		} catch (error) {
			this.logEvent('decryptHistoryMessage', error, 'error')
		}
		return null
	}

	async createClientChannel() {
		const keys = await crypto.subtle.generateKey(
			{
				name: 'ECDH',
				namedCurve: 'P-384'
			},
			true,
			['deriveBits']
		);
		return {
			username: null,
			keys,
			publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'),
			shared: null,
		}
	}

	async deriveClientSharedKey(channelState, peerPublicKeyHex) {
		if (!channelState || !channelState.keys || !this.credentials || !this.isString(peerPublicKeyHex)) {
			return null
		}

		const peerPublicKey = await crypto.subtle.importKey(
			'raw',
			Buffer.from(peerPublicKeyHex, 'hex'),
			{
				name: 'ECDH',
				namedCurve: 'P-384'
			},
			false,
			[]
		);
		const sharedBits = await crypto.subtle.deriveBits(
			{
				name: 'ECDH',
				public: peerPublicKey
			},
			channelState.keys.privateKey,
			384
		);
		const keyHex = sha256(`nodecrypt-client-v2|${Buffer.from(sharedBits).toString('hex')}|${this.credentials.password}`);
		return crypto.subtle.importKey(
			'raw',
			Buffer.from(keyHex, 'hex'),
			{
				name: 'AES-GCM'
			},
			false,
			['encrypt', 'decrypt']
		)
	}

	// Encrypt a message for the server
	// 加密发送给服务器的消息
	encryptServerMessage(message, key) {
		let encrypted = '';
		try {
			message = Buffer.from(JSON.stringify(message), 'utf8');
			if ((message.length % 16) !== 0) {
				message = Buffer.from([...message, ...Buffer.alloc(16 - (message.length % 16))])
			}
			const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
			const cipher = new ModeOfOperation.cbc(key, iv);
			encrypted = iv.toString('base64') + '|' + Buffer.from(cipher.encrypt(message)).toString('base64')
		} catch (error) {
			this.logEvent('encryptServerMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from the server
	// 解密来自服务器的消息
	decryptServerMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			const decipher = new ModeOfOperation.cbc(key, Buffer.from(parts[0], 'base64'));
			decrypted = JSON.parse(Buffer.from(decipher.decrypt(Buffer.from(parts[1], 'base64'))).toString('utf8').replace(/\0+$/, ''))
		} catch (error) {
			this.logEvent('decryptServerMessage', error, 'error')
		}
		return (decrypted)
	}

	// Encrypt a message for a client
	// 加密发送给客户端的消息
	async encryptClientMessage(message, key) {
		let encrypted = '';
		try {
			const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
			const ciphertext = await crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv: nonce
				},
				key,
				Buffer.from(JSON.stringify(message), 'utf8')
			);
			encrypted = `g1|${nonce.toString('base64')}|${Buffer.from(ciphertext).toString('base64')}`
		} catch (error) {
			this.logEvent('encryptClientMessage', error, 'error')
		}
		return (encrypted)
	}

	// Decrypt a message from a client
	// 解密来自客户端的消息
	async decryptClientMessage(message, key) {
		let decrypted = {};
		try {
			const parts = message.split('|');
			if (parts.length !== 3 || parts[0] !== 'g1') {
				return decrypted
			}
			const plaintext = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: Buffer.from(parts[1], 'base64')
				},
				key,
				Buffer.from(parts[2], 'base64')
			);
			decrypted = JSON.parse(Buffer.from(plaintext).toString('utf8'))
		} catch (error) {
			this.logEvent('decryptClientMessage', error, 'error')
		}
		return (decrypted)
	}

	// Check if value is a string
	// 检查值是否为字符串
	isString(value) {
		return (value && Object.prototype.toString.call(value) === '[object String]' ? true : false)
	}

	// Check if value is an array
	// 检查值是否为数组
	isArray(value) {
		return (value && Object.prototype.toString.call(value) === '[object Array]' ? true : false)
	}

	// Check if value is an object
	// 检查值是否为对象
	isObject(value) {
		return (value && Object.prototype.toString.call(value) === '[object Object]' ? true : false)
	}

	// Handle server public key
	// 处理服务器公钥
	async handleServerKey(serverKey) {
		this.logEvent('handleServerKey', 'Received server key');

		if (!this.isString(serverKey) || !/^[A-Za-z0-9+/=]+$/.test(serverKey)) {
			if (this.callbacks.onServerTrustError) {
				this.callbacks.onServerTrustError({ reason: 'invalid-key' })
			}
			this.credentials = null;
			this.disconnect();
			return false
		}

		const storageKey = this.getServerKeyStorageKey();
		const pinnedKey = localStorage.getItem(storageKey);

		if (pinnedKey && pinnedKey !== serverKey) {
			let trustNewKey = false;

			if (this.callbacks.onServerKeyChanged) {
				try {
					trustNewKey = await this.callbacks.onServerKeyChanged({
						oldKey: pinnedKey,
						newKey: serverKey,
						storageKey
					})
				} catch (error) {
					this.logEvent('handleServerKey-callback', error, 'error')
				}
			}

			if (!trustNewKey) {
				if (this.callbacks.onServerTrustError) {
					this.callbacks.onServerTrustError({ reason: 'key-changed' })
				}
				this.credentials = null;
				this.disconnect();
				return false
			}
		}

		localStorage.setItem(storageKey, serverKey);
		if (storageKey !== this.SERVER_KEY_STORAGE) {
			localStorage.removeItem(this.SERVER_KEY_STORAGE)
		}
		this.config.rsaPublic = serverKey;
		return true
	}
};

if (typeof window !== 'undefined') {
	window.NodeCrypt = NodeCrypt
}
