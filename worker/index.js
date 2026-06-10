import { hkdfSync } from 'node:crypto';
import { generateClientId, encryptMessage, decryptMessage, logEvent, isString, isObject, getTime, createRateLimiter, appendToHistoryBacklog, packClientAttachment, unpackClientAttachment } from './utils.js';

const ROOM_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SEEN_TIMEOUT_MS = 60000;
const HISTORY_MAX_MESSAGES = 100;
const HISTORY_MAX_BYTES = 256 * 1024;
const HISTORY_MAX_ENTRY_BYTES = 16 * 1024;
// Temporary room history lives in DO storage (key 'history:<channel>') instead of instance
// memory, so it survives hibernation/eviction while members stay connected.
const HISTORY_KEY_PREFIX = 'history:';
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
    "img-src 'self' data: blob: https://image.757605.xyz",
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

    // Use objects like original server.js instead of Maps.
    // These maps are only a cache: the durable copy of per-connection state lives in each
    // WebSocket's attachment, so everything here can be rebuilt after hibernation.
    this.clients = {};
    this.channels = {};
    this.socketClients = new Map();
    this.rehydrated = false;
    this.lastCleanup = 0;
    // Read-through cache over the per-channel history backlog in DO storage. Storage stays
    // the single source of truth (every accepted append still storage.put()s); the cache only
    // skips the per-message storage.get and is discarded/rebuilt across hibernation.
    // 频道历史的 read-through 缓存：storage 仍是唯一真源（每次接受仍照常 put），
    // 缓存只省去逐消息的 storage.get，休眠后随实例丢弃并按需重建。
    this.historyCache = new Map();

    this.config = {
      seenTimeout: SEEN_TIMEOUT_MS,
      historyMaxMessages: HISTORY_MAX_MESSAGES,
      historyMaxBytes: HISTORY_MAX_BYTES,
      debug: false
    };

    // Let the runtime answer keep-alive pings without waking a hibernated DO;
    // getWebSocketAutoResponseTimestamp() then feeds the seen-timeout sweep. If the API is
    // unavailable, the in-handler 'ping' branch still responds (at the cost of a wake-up).
    try {
      this.state.setWebSocketAutoResponse(new WebSocketRequestResponse('ping', 'pong'));
    } catch (error) {
      logEvent('auto-response', error, 'error');
    }

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

    this.ensureStateRehydrated();

    // 清理旧连接
    await this.cleanupOldConnections(true);

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const expectedRoomHash = getExpectedRoomHash(new URL(request.url));

    // Hibernation API: the runtime owns the socket, so this DO can be evicted while the
    // connection stays open; events are delivered to the webSocket* class methods below.
    this.state.acceptWebSocket(server);

    const clientId = generateClientId();

    if (!clientId || this.clients[clientId]) {
      this.closeConnection(server);
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    logEvent('connection', clientId, 'debug');

    this.clients[clientId] = {
      clientId,
      connection: server,
      seen: getTime(),
      persistedSeen: 0,
      shared: null,
      channel: null,
      expectedRoomHash,
      rateLimiter: this.createConnectionRateLimiter()
    };
    this.socketClients.set(server, clientId);
    this.persistClientAttachment(this.clients[clientId]);

    // Send RSA public key
    try {
      logEvent('sending-public-key', clientId, 'debug');
      this.sendMessage(server, JSON.stringify({
        type: 'server-key',
        key: this.keyPair.rsaPublic
      }));
    } catch (error) {
      logEvent('sending-public-key', error, 'error');
    }

    await this.armCleanupAlarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  // After hibernation the in-memory maps are empty while the runtime still holds the
  // sockets. Rebuild clients/channels from each socket's attachment before handling any
  // event; every entry point (fetch / webSocket* handlers / alarm) calls this first.
  ensureStateRehydrated() {
    if (this.rehydrated) {
      return;
    }
    this.rehydrated = true;

    for (const connection of this.state.getWebSockets()) {
      let attachment = null;
      try {
        attachment = unpackClientAttachment(connection.deserializeAttachment());
      } catch (error) {
        logEvent('rehydrate-attachment', error, 'error');
      }

      if (!attachment || this.clients[attachment.clientId]) {
        this.closeConnection(connection);
        continue;
      }

      this.clients[attachment.clientId] = {
        clientId: attachment.clientId,
        connection: connection,
        seen: attachment.seen || getTime(),
        persistedSeen: attachment.seen || 0,
        shared: attachment.shared,
        channel: attachment.channel,
        expectedRoomHash: attachment.expectedRoomHash,
        // Rate limiters are in-memory only; a window reset across a wake-up is acceptable.
        rateLimiter: null
      };
      this.socketClients.set(connection, attachment.clientId);

      if (attachment.channel) {
        if (!this.channels[attachment.channel]) {
          this.channels[attachment.channel] = [];
        }
        this.channels[attachment.channel].push(attachment.clientId);
      }
    }
  }

  // The attachment is the durable copy of per-connection state: everything needed to keep
  // serving a socket after eviction (clientId, link key, room) must live there, not in
  // instance fields. Rewritten on every state change plus a throttled 'seen' refresh.
  persistClientAttachment(client) {
    try {
      client.persistedSeen = client.seen;
      client.connection.serializeAttachment(packClientAttachment(client));
    } catch (error) {
      logEvent('persist-attachment', error, 'error');
    }
  }

  createConnectionRateLimiter() {
    return createRateLimiter({
      windowMs: WINDOW_MS,
      maxMessages: MAX_MESSAGES_PER_WINDOW,
      maxBytes: MAX_BYTES_PER_WINDOW
    });
  }

  lookupClientId(connection) {
    let clientId = this.socketClients.get(connection);
    if (clientId === undefined) {
      // Defensive: re-link via the attachment if the runtime hands us an unmapped socket.
      try {
        const attachment = unpackClientAttachment(connection.deserializeAttachment());
        if (attachment) {
          clientId = attachment.clientId;
        }
      } catch {}
    }
    return clientId;
  }

  dropClient(clientId) {
    const client = this.clients[clientId];
    if (!client) {
      return;
    }
    this.socketClients.delete(client.connection);
    delete this.clients[clientId];
  }

  // The persisted 'seen' may lag (throttled writes), and pings answered by the runtime
  // while hibernated only advance the auto-response timestamp; liveness is the max of both.
  effectiveSeen(client) {
    let seen = client.seen || 0;
    try {
      const autoSeen = this.state.getWebSocketAutoResponseTimestamp?.(client.connection);
      if (autoSeen) {
        seen = Math.max(seen, autoSeen.getTime());
      }
    } catch {}
    return seen;
  }

  async webSocketMessage(connection, message) {
    this.ensureStateRehydrated();

    const clientId = this.lookupClientId(connection);
    const client = clientId ? this.clients[clientId] : null;

    if (!isString(message) || !client) {
      return;
    }

    if (!client.rateLimiter) {
      client.rateLimiter = this.createConnectionRateLimiter();
    }

    if (!client.rateLimiter.allow(message.length)) {
      logEvent('rate-limit', clientId, 'error');
      this.closeConnection(connection, 1009, 'rate limit');
      await this.removeClientFromChannel(clientId, client.channel);
      this.dropClient(clientId);
      return;
    }

    client.seen = getTime();
    if (client.seen - client.persistedSeen >= CLEANUP_INTERVAL_MS) {
      this.persistClientAttachment(client);
    }
    await this.cleanupOldConnections();

    if (message === 'ping') {
      // Normally intercepted by setWebSocketAutoResponse; kept as a fallback.
      this.sendMessage(connection, 'pong');
      return;
    }

    logEvent('message', [clientId, message], 'debug');

    // Handle key exchange
    if (!client.shared && message.length < 2048) {
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
        );

        // Server link protocol v2: HKDF-SHA256 over the full 48-byte secret (was bytes 8-40).
        client.shared = Buffer.from(hkdfSync(
          'sha256',
          new Uint8Array(sharedSecretBits),
          SERVER_LINK_HKDF_SALT,
          SERVER_LINK_HKDF_INFO,
          32
        ));

        // The agreed link key is connection state; persist it so the link survives hibernation.
        this.persistClientAttachment(client);

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
    if (client.shared && message.length <= (8 * 1024 * 1024)) {
      await this.processEncryptedMessage(clientId, message);
    }
  }

  async webSocketClose(connection, code, reason, wasClean) {
    this.ensureStateRehydrated();
    logEvent('close', [this.socketClients.get(connection), { code, reason, wasClean }], 'debug');
    // The hibernation API does not auto-acknowledge a client-initiated close: without an
    // explicit close() the browser socket hangs in CLOSING until its ~10s handshake timeout,
    // delaying the client's close event and reconnect. (The legacy accept() API did this
    // automatically.) closeConnection() swallows the error if the socket is already closed.
    this.closeConnection(connection);
    await this.releaseSocket(connection);
  }

  async webSocketError(connection, error) {
    this.ensureStateRehydrated();
    logEvent('websocket-error', error, 'error');
    this.closeConnection(connection);
    await this.releaseSocket(connection);
  }

  async releaseSocket(connection) {
    const clientId = this.lookupClientId(connection);
    this.socketClients.delete(connection);

    if (!clientId || !this.clients[clientId]) {
      return;
    }

    await this.removeClientFromChannel(clientId, this.clients[clientId].channel);
    this.dropClient(clientId);

    if (Object.keys(this.clients).length === 0) {
      // Last connection is gone; let the cleanup alarm lapse instead of renewing forever.
      try {
        await this.state.storage.deleteAlarm();
      } catch (error) {
        logEvent('delete-alarm', error, 'error');
      }
    }
  }

  // Periodic sweep of half-open/idle connections. A setInterval would die with the
  // in-memory instance, so this must be a storage alarm: it survives hibernation (and
  // restarts) and wakes the DO to run the sweep.
  async alarm() {
    this.ensureStateRehydrated();
    await this.cleanupOldConnections(true);
    await this.purgeOrphanHistory();
    await this.armCleanupAlarm();
  }

  // Schedule the sweep at the earliest moment a current connection could time out, so an
  // idle room wakes at most about once per seenTimeout. Not re-armed once the room is empty.
  async armCleanupAlarm() {
    try {
      let earliest = null;
      for (const clientId in this.clients) {
        const deadline = this.effectiveSeen(this.clients[clientId]) + this.config.seenTimeout;
        if (earliest === null || deadline < earliest) {
          earliest = deadline;
        }
      }
      if (earliest === null) {
        return;
      }
      await this.state.storage.setAlarm(Math.max(getTime() + 1000, earliest + 1000));
    } catch (error) {
      logEvent('arm-alarm', error, 'error');
    }
  }
  // Process encrypted messages
  async processEncryptedMessage(clientId, message) {
    let decrypted = null;

    try {
      decrypted = decryptMessage(message, this.clients[clientId].shared);

      logEvent('message-decrypted', [clientId, decrypted], 'debug');

      if (!isObject(decrypted) || !isString(decrypted.a)) {
        return;
      }

      const action = decrypted.a;

      if (action === 'j') {
        await this.handleJoinChannel(clientId, decrypted);
      } else if (action === 'c') {
        this.handleClientMessage(clientId, decrypted);
      } else if (action === 'w') {
        this.handleChannelMessage(clientId, decrypted);
      } else if (action === 'h') {
        await this.handleHistoryMessage(clientId, decrypted);
      }

    } catch (error) {
      logEvent('process-encrypted-message', [clientId, error], 'error');
    } finally {
      decrypted = null;
    }
  }
  // Handle channel join requests
  async handleJoinChannel(clientId, decrypted) {
    if (!isString(decrypted.p) || !ROOM_HASH_PATTERN.test(decrypted.p) || this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = decrypted.p.toLowerCase();
      const expectedRoomHash = this.clients[clientId].expectedRoomHash;
      if (!isJoinRoomAllowed(expectedRoomHash, channel)) {
        logEvent('message-join-room-mismatch', clientId, 'error');
        this.closeConnection(this.clients[clientId].connection);
        this.dropClient(clientId);
        return;
      }

      if (this.channels[channel] && this.channels[channel].length >= MAX_CLIENTS_PER_ROOM) {
        logEvent('message-join-room-full', clientId, 'error');
        this.closeConnection(this.clients[clientId].connection, 1008, 'room full');
        this.dropClient(clientId);
        return;
      }

      this.clients[clientId].channel = channel;

      const isFirstMember = !this.channels[channel];
      if (isFirstMember) {
        this.channels[channel] = [clientId];
        // The room was empty, so any stored backlog is orphaned (e.g. sockets dropped by a
        // redeploy without webSocketClose); purge it so history never outlives the members.
        await this.deleteHistoryBacklog(channel);
      } else {
        this.channels[channel].push(clientId);
      }

      // Joining a room is connection state; persist it for post-hibernation rebuilds.
      this.persistClientAttachment(this.clients[clientId]);

      if (!isFirstMember) {
        await this.sendHistoryBacklog(clientId, channel);
      }
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
  async handleHistoryMessage(clientId, decrypted) {
    if (!isString(decrypted.p) || !this.clients[clientId].channel) {
      return;
    }

    try {
      const channel = this.clients[clientId].channel;
      await this.appendHistoryEntry(channel, decrypted.p);
    } catch (error) {
      logEvent('message-history', [clientId, error], 'error');
    }
  }
  historyStorageKey(channel) {
    return HISTORY_KEY_PREFIX + channel;
  }
  // Cache miss falls back to storage; the cached array is the working copy that all
  // mutations go through, so it always mirrors the last storage.put.
  // 缓存未命中时回源 storage；缓存数组即工作副本，所有变更都经由它，与最近一次 put 保持一致。
  async getHistoryBacklog(channel) {
    let backlog = this.historyCache.get(channel);
    if (backlog === undefined) {
      backlog = (await this.state.storage.get(this.historyStorageKey(channel))) || [];
      this.historyCache.set(channel, backlog);
    }
    return backlog;
  }
  // History lives in DO storage so it survives eviction/hibernation while members stay
  // connected (instance memory would silently drop it). Plain read-modify-write is safe:
  // the DO input gate serializes events around storage operations.
  async appendHistoryEntry(channel, encryptedHistory) {
    if (!channel) {
      return;
    }

    const backlog = await this.getHistoryBacklog(channel);

    const accepted = appendToHistoryBacklog(backlog, encryptedHistory, {
      maxMessages: this.config.historyMaxMessages,
      maxBytes: this.config.historyMaxBytes,
      maxEntryBytes: HISTORY_MAX_ENTRY_BYTES
    });

    if (accepted) {
      await this.state.storage.put(this.historyStorageKey(channel), backlog);
    }
  }
  async sendHistoryBacklog(clientId, channel) {
    try {
      const client = this.clients[clientId];

      if (!this.isClientInChannel(client, channel)) {
        return;
      }

      const backlog = await this.getHistoryBacklog(channel);
      if (!backlog || backlog.length === 0) {
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
  async deleteHistoryBacklog(channel) {
    try {
      this.historyCache.delete(channel);
      await this.state.storage.delete(this.historyStorageKey(channel));
    } catch (error) {
      logEvent('history-delete', error, 'error');
    }
  }
  // Drop stored history for channels that no longer have live members (e.g. after a crash
  // or redeploy where webSocketClose never fired), keeping "last member leaves => history
  // gone" true across restarts.
  async purgeOrphanHistory() {
    try {
      const stored = await this.state.storage.list({ prefix: HISTORY_KEY_PREFIX });
      for (const key of stored.keys()) {
        const channel = key.slice(HISTORY_KEY_PREFIX.length);
        if (!this.channels[channel] || this.channels[channel].length === 0) {
          this.historyCache.delete(channel);
          await this.state.storage.delete(key);
        }
      }
    } catch (error) {
      logEvent('history-purge', error, 'error');
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
  async removeClientFromChannel(clientId, channel, notifyMembers = true) {
    if (!channel || !this.channels[channel]) {
      return;
    }

    const index = this.channels[channel].indexOf(clientId);
    if (index >= 0) {
      this.channels[channel].splice(index, 1);
    }

    if (this.channels[channel].length === 0) {
      delete(this.channels[channel]);
      // Invariant: stored history is deleted the moment the last member leaves.
      await this.deleteHistoryBacklog(channel);
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
      if (this.effectiveSeen(this.clients[clientId]) < seenThreshold) {
        clientsToRemove.push(clientId);
      }
    }

    // 然后一次性移除所有过期客户端
    for (const clientId of clientsToRemove) {
      try {
        logEvent('connection-seen', clientId, 'debug');
        await this.removeClientFromChannel(clientId, this.clients[clientId].channel);
        this.closeConnection(this.clients[clientId].connection);
        this.dropClient(clientId);
      } catch (error) {
        logEvent('connection-seen', error, 'error');
      }
    }
    return clientsToRemove.length; // 返回清理的连接数量
  }
}
