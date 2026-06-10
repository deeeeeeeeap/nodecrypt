import { hkdfSync } from 'node:crypto';
import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime, createRateLimiter } from './utils.js';

const ROOM_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SEEN_TIMEOUT_MS = 60000;
const HISTORY_MAX_MESSAGES = 100;
const HISTORY_MAX_BYTES = 256 * 1024;
const HISTORY_MAX_ENTRY_BYTES = 16 * 1024;
const CLEANUP_INTERVAL_MS = 10000;
// Server link protocol v2 HKDF parameters; must match client/js/util.serverCrypto.js exactly.
const SERVER_LINK_HKDF_SALT = 'nodecrypt-server-link-v2';
const SERVER_LINK_HKDF_INFO = 'aes-256-gcm';
// Per-connection application-layer rate limits.
// Sized as an abuse ceiling, not traffic shaping: legitimate bursts (200MB max file
// -> ~273MB base64 volumes plus NACK resends and multi-receiver fan-out) must never trip it.
const WINDOW_MS = 10000;
const MAX_MESSAGES_PER_WINDOW = 2400;
const MAX_BYTES_PER_WINDOW = 768 * 1024 * 1024;
const MAX_CLIENTS_PER_ROOM = 64;
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' wss: ws://localhost:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()'
};

function isLocalHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function getRequestScheme(request, url) {
  const cfVisitor = request.headers.get('cf-visitor');
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor);
      const scheme = parsed && typeof parsed.scheme === 'string' ? parsed.scheme.toLowerCase() : '';
      if (scheme === 'http' || scheme === 'https') {
        return scheme;
      }
    } catch {}
  }

  const urlScheme = url.protocol.replace(':', '').toLowerCase();
  if (urlScheme === 'http' || urlScheme === 'https') {
    return urlScheme;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) {
    const scheme = forwardedProto.split(',')[0].trim().toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      return scheme;
    }
  }

  return urlScheme;
}

export function shouldRedirectToHttps(request, url) {
  return !isLocalHostname(url.hostname) && getRequestScheme(request, url) === 'http';
}

function withResponseHeaders(response, url) {
  if (isLocalHostname(url.hostname)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  const contentType = (headers.get('Content-Type') || '').toLowerCase();
  if (url.pathname.startsWith('/assets/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (contentType.includes('text/html') || url.pathname === '/' || url.pathname.endsWith('.html')) {
    headers.set('Cache-Control', 'no-cache');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function getExpectedRoomHash(url) {
	const roomHash = url.searchParams.get('room');

	if (roomHash && ROOM_HASH_PATTERN.test(roomHash)) {
		return roomHash.toLowerCase();
	}

	return null;
}

export function getRoomObjectName(url) {
  const roomHash = getExpectedRoomHash(url);

  if (roomHash) {
    return `room:${roomHash}`;
  }

	return null;
}

export function isJoinRoomAllowed(expectedRoomHash, channel) {
  return Boolean(expectedRoomHash) && channel === expectedRoomHash;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (shouldRedirectToHttps(request, url)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }

    // 处理WebSocket请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      const roomObjectName = getRoomObjectName(url);
      if (!roomObjectName) {
        return new Response('Invalid room', { status: 400 });
      }
      const id = env.CHAT_ROOM.idFromName(roomObjectName);
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // 其余全部交给 ASSETS 处理（自动支持 hash 文件名和 SPA fallback）
    return withResponseHeaders(await env.ASSETS.fetch(request), url);
  }
};

export class ChatRoom {  constructor(state, env) {
    this.state = state;
    
    // Use objects like original server.js instead of Maps
    this.clients = {};
    this.channels = {};
    this.historyBacklogs = {};
    this.lastCleanup = 0;
    
    this.config = {
      seenTimeout: SEEN_TIMEOUT_MS,
      historyMaxMessages: HISTORY_MAX_MESSAGES,
      historyMaxBytes: HISTORY_MAX_BYTES,
      debug: false
    };
    
    // Serialize startup storage access so concurrent WebSocket upgrades cannot race key generation.
    this.ready = this.state.blockConcurrencyWhile(() => this.initRSAKeyPair());
  }

  async initRSAKeyPair() {
    try {
      let stored = await this.state.storage.get('rsaKeyPair');
      if (!stored) {
        console.log('Generating new RSA keypair...');
          const keyPair = await crypto.subtle.generateKey(
          {
            name: 'RSASSA-PKCS1-v1_5',
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: 'SHA-256'
          },
          true,
          ['sign', 'verify']
        );

        // 并行导出公钥和私钥以提高性能
        const [publicKeyBuffer, privateKeyBuffer] = await Promise.all([
          crypto.subtle.exportKey('spki', keyPair.publicKey),
          crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
        ]);
        
        stored = {
          rsaPublic: btoa(String.fromCharCode(...new Uint8Array(publicKeyBuffer))),
          rsaPrivateData: Array.from(new Uint8Array(privateKeyBuffer))
        };
        
        await this.state.storage.put('rsaKeyPair', stored);
        console.log('RSA key pair generated and stored');
      }
      
      // Reconstruct the private key
      if (stored.rsaPrivateData) {
        const privateKeyBuffer = new Uint8Array(stored.rsaPrivateData);
        
        stored.rsaPrivate = await crypto.subtle.importKey(
          'pkcs8',
          privateKeyBuffer,
          {
            name: 'RSASSA-PKCS1-v1_5',
            hash: 'SHA-256'
          },
          false,
          ['sign']
        );      }
        this.keyPair = stored;
    } catch (error) {
      console.error('Error initializing RSA key pair:', error);
      throw error;
    }
  }

  async fetch(request) {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    // Ensure RSA keys are initialized before accepting the session.
    await this.ready;
    if (!this.keyPair) {
      await this.initRSAKeyPair();
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept the WebSocket connection
    const expectedRoomHash = getExpectedRoomHash(new URL(request.url));
    this.handleSession(server, expectedRoomHash);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }  // WebSocket connection event handler
  async handleSession(connection, expectedRoomHash = null) {    connection.accept();

    // 清理旧连接
    await this.cleanupOldConnections(true);

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(connection);
      return;
    }

    logEvent('connection', clientId, 'debug');    // Store client information
    this.clients[clientId] = {
      connection: connection,
      seen: getTime(),
      key: null,
      shared: null,
      channel: null,
      expectedRoomHash
    };

    const rateLimiter = createRateLimiter({
      windowMs: WINDOW_MS,
      maxMessages: MAX_MESSAGES_PER_WINDOW,
      maxBytes: MAX_BYTES_PER_WINDOW
    });

    // Send RSA public key
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(connection, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }    // Handle messages
    connection.addEventListener('message', async (event) => {
      const message = event.data;

      if (!isString(message) || !this.clients[clientId]) {
        return;
      }

      if (!rateLimiter.allow(message.length)) {
        logEvent('rate-limit', clientId, 'error');
        this.closeConnection(connection, 1009, 'rate limit');
        this.removeClientFromChannel(clientId, this.clients[clientId].channel);
        delete this.clients[clientId];
        return;
      }

      this.clients[clientId].seen = getTime();
      await this.cleanupOldConnections();

      if (message === 'ping') {
        this.sendMessage(connection, 'pong');
        return;
      }

      logEvent('message', [clientId, message], 'debug');      // Handle key exchange
      if (!this.clients[clientId].shared && message.length < 2048) {
        try {
          // Generate ECDH key pair using P-384 curve (equivalent to secp384r1)
          const keys = await crypto.subtle.generateKey(
            {
              name: 'ECDH',
              namedCurve: 'P-384'
            },
            true,
            ['deriveBits', 'deriveKey']
          );

          const publicKeyBuffer = await crypto.subtle.exportKey('raw', keys.publicKey);
          
          // Sign the public key using PKCS1 padding (compatible with original)
          const signature = await crypto.subtle.sign(
            {
              name: 'RSASSA-PKCS1-v1_5'
            },
            this.keyPair.rsaPrivate,
            publicKeyBuffer
          );

          // Convert hex string to Uint8Array for client public key
          const clientPublicKeyHex = message;
          const clientPublicKeyBytes = new Uint8Array(clientPublicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
          
          // Import client's public key
          const clientPublicKey = await crypto.subtle.importKey(
            'raw',
            clientPublicKeyBytes,
            { name: 'ECDH', namedCurve: 'P-384' },
            false,
            []
          );

          // Derive shared secret bits (equivalent to computeSecret in Node.js)
          const sharedSecretBits = await crypto.subtle.deriveBits(
            {
              name: 'ECDH',
              public: clientPublicKey
            },
            keys.privateKey,
            384 // P-384 produces 48 bytes (384 bits)
          );          // Server link protocol v2: HKDF-SHA256 over the full 48-byte secret (was bytes 8-40).
          this.clients[clientId].shared = Buffer.from(hkdfSync(
            'sha256',
            new Uint8Array(sharedSecretBits),
            SERVER_LINK_HKDF_SALT,
            SERVER_LINK_HKDF_INFO,
            32
          ));

          const response = Array.from(new Uint8Array(publicKeyBuffer))
            .map(b => b.toString(16).padStart(2, '0')).join('') + 
            '|' + btoa(String.fromCharCode(...new Uint8Array(signature)));
          
          this.sendMessage(connection, response);

        } catch (error) {
          logEvent('message-key', [clientId, error], 'error');
          this.closeConnection(connection);
        }

        return;
      }

      // Handle encrypted messages
      if (this.clients[clientId].shared && message.length <= (8 * 1024 * 1024)) {
        this.processEncryptedMessage(clientId, message);
      }
    });    // Handle connection close
    connection.addEventListener('close', async (event) => {
      logEvent('close', [clientId, event], 'debug');

      const client = this.clients[clientId];
      if (!client) {
        return;
      }

      this.removeClientFromChannel(clientId, client.channel);

      if (this.clients[clientId]) {
        delete(this.clients[clientId]);
      }
    });
  }
  // Process encrypted messages
  processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      } else if (action === 'h') {
        this.handleHistoryMessage(clientId, decrypted);
      }

    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }
  // Handle channel join requests
  handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || !ROOM_HASH_PATTERN.test(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p.toLowerCase();
      const expectedRoomHash = this.clients[clientId].expectedRoomHash;
      if (!isJoinRoomAllowed(expectedRoomHash, channel)) {
        logEvent('message-join-room-mismatch', clientId, 'error');
        this.closeConnection(this.clients[clientId].connection);
        delete this.clients[clientId];
        return;
      }

      if (this.channels[channel] && this.channels[channel].length >= MAX_CLIENTS_PER_ROOM) {
        logEvent('message-join-room-full', clientId, 'error');
        this.closeConnection(this.clients[clientId].connection, 1008, 'room full');
        delete this.clients[clientId];
        return;
      }

      this.clients[clientId].channel = channel;

      if (!this.channels[channel]) {
        this.channels[channel] = [clientId];
      } else {
        this.channels[channel].push(clientId);
      }

      this.sendHistoryBacklog(clientId, channel);
      this.broadcastMemberList(channel);

    } catch (error) {
      logEvent('message-join', [clientId, error], 'error');
    }
  }
  // Handle client messages
  handleClientMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !isString(decrypted.c) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      const targetClient = this.clients[decrypted.c];

      if (this.isClientInChannel(targetClient, channel)) {
        const messageObj = {
          a: 'c',
          p: decrypted.p,
          c: clientId
        };

        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-client', [clientId, error], 'error');
    }
  }  // Handle channel messages
  handleChannelMessage(clientId, decrypted) {
    if (!isObject(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }
    
    try {
      const channel = this.clients[clientId].channel;
      // 过滤有效的目标成员
      const validMembers = Object.keys(decrypted.p).filter(member => {
        const targetClient = this.clients[member];
        return isString(decrypted.p[member]) && this.isClientInChannel(targetClient, channel);
      });

      // 处理所有有效的目标成员
      for (const member of validMembers) {
        const targetClient = this.clients[member];
        const messageObj = {
          a: 'c',
          p: decrypted.p[member],
          c: clientId
        };        const encrypted = encryptMessage(messageObj, targetClient.shared);
        this.sendMessage(targetClient.connection, encrypted);

        messageObj.p = null;
      }

    } catch (error) {
      logEvent('message-channel', [clientId, error], 'error');
    }
  }
  // Cache room-history ciphertext. The Worker never decrypts message content.
  handleHistoryMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      this.appendHistoryEntry(channel, decrypted.p);
    } catch (error) {
      logEvent('message-history', [clientId, error], 'error');
    }
  }
  appendHistoryEntry(channel, encryptedHistory) {
    if (!channel || !isString(encryptedHistory) || encryptedHistory.length > HISTORY_MAX_ENTRY_BYTES) {
      return;
    }

    if (!this.historyBacklogs[channel]) {
      this.historyBacklogs[channel] = [];
    }

    const backlog = this.historyBacklogs[channel];
    backlog.push(encryptedHistory);

    while (backlog.length > this.config.historyMaxMessages) {
      backlog.shift();
    }

    let totalBytes = backlog.reduce((sum, item) => sum + item.length, 0);
    while (totalBytes > this.config.historyMaxBytes && backlog.length > 0) {
      const removed = backlog.shift();
      totalBytes -= removed ? removed.length : 0;
    }
  }
  sendHistoryBacklog(clientId, channel) {
    try {
      const client = this.clients[clientId];
      const backlog = this.historyBacklogs[channel];

      if (!this.isClientInChannel(client, channel) || !backlog || backlog.length === 0) {
        return;
      }

      const encrypted = encryptMessage({
        a: 'h',
        p: backlog
      }, client.shared);
      this.sendMessage(client.connection, encrypted);
    } catch (error) {
      logEvent('history-backlog', [clientId, error], 'error');
    }
  }
  // Broadcast member list to channel
  broadcastMemberList(channel) {
    try {
      const members = this.channels[channel];

      for (const member of members) {
        const client = this.clients[member];

        if (this.isClientInChannel(client, channel)) {
          const messageObj = {
            a: 'l',
            p: members.filter((value) => {
              return (value !== member ? true : false);
            })
          };

          const encrypted = encryptMessage(messageObj, client.shared);
          this.sendMessage(client.connection, encrypted);

          messageObj.p = null;
        }
      }
    } catch (error) {
      logEvent('broadcast-member-list', error, 'error');
    }
  }
  // Remove a client from its channel and notify remaining members.
  removeClientFromChannel(clientId, channel, notifyMembers = true) {
    if (!channel || !this.channels[channel]) {
      return;
    }

    const index = this.channels[channel].indexOf(clientId);
    if (index >= 0) {
      this.channels[channel].splice(index, 1);
    }

    if (this.channels[channel].length === 0) {
      delete(this.channels[channel]);
      delete(this.historyBacklogs[channel]);
      return;
    }

    if (notifyMembers) {
      this.broadcastMemberList(channel);
    }
  }
  // Check if client is in channel
  isClientInChannel(client, channel) {
    return (
      client &&
      client.connection &&
      client.shared &&
      client.channel &&
      client.channel === channel ?
      true :
      false
    );
  }
  // Send message helper
  sendMessage(connection, message) {
    try {
      // In Cloudflare Workers, WebSocket.READY_STATE_OPEN is 1
      if (connection.readyState === 1) {
        connection.send(message);
      }
    } catch (error) {
      logEvent('sendMessage', error, 'error');
    }
  }  // Close connection helper
  closeConnection(connection, code, reason) {
    try {
      if (code) {
        connection.close(code, reason);
      } else {
        connection.close();
      }
    } catch (error) {
      logEvent('closeConnection', error, 'error');
    }
  }
  
  // 连接清理方法
  async cleanupOldConnections(force = false) {
    const now = getTime();
    if (!force && now - this.lastCleanup < CLEANUP_INTERVAL_MS) {
      return 0;
    }
    this.lastCleanup = now;

    const seenThreshold = now - this.config.seenTimeout;
    const clientsToRemove = [];

    // 先收集需要移除的客户端，避免在迭代时修改对象
    for (const clientId in this.clients) {
      if (this.clients[clientId].seen < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 然后一次性移除所有过期客户端
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        this.removeClientFromChannel(clientId, this.clients[clientId].channel);
        this.clients[clientId].connection.close();
        delete this.clients[clientId];
      } catch (error) {
        logEvent('connection-seen', error, 'error');      }
    }
    return clientsToRemove.length; // 返回清理的连接数量
  }
}
