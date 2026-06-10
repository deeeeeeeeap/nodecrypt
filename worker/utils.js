import crypto from 'node:crypto';

export const generateClientId = () => {
  try {
    return (crypto.randomBytes(8).toString('hex'));
  } catch (error) {
    logEvent('generateClientId', error, 'error');
    return (null);
  }
};

// Server link protocol v2 envelope: base64(iv12) + '|' + base64(ciphertext || 16-byte GCM tag).
// The tag is appended to the ciphertext to match the WebCrypto AES-GCM layout used by the client.
export const encryptMessage = (message, key) => {

  let encrypted = '';

  try {

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(message), 'utf8')),
      cipher.final(),
      cipher.getAuthTag()
    ]);

    encrypted = iv.toString('base64') + '|' + ciphertext.toString('base64');

  } catch (error) {
    logEvent('encryptMessage', error, 'error');
  }

  return (encrypted);

};

// Returns the parsed object, or null on any failure (malformed envelope, auth tag mismatch, bad JSON).
export const decryptMessage = (message, key) => {

  try {

    const parts = message.split('|');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return (null);
    }

    const iv = Buffer.from(parts[0], 'base64');
    const payload = Buffer.from(parts[1], 'base64');
    if (iv.length !== 12 || payload.length < 16) {
      return (null);
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(payload.subarray(payload.length - 16));

    const decrypted = Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - 16)),
      decipher.final()
    ]);

    return (JSON.parse(decrypted.toString('utf8')));

  } catch (error) {
    logEvent('decryptMessage', error, 'error');
  }

  return (null);

};

// Fixed-window application-layer rate limiter; one instance per WebSocket connection.
// `now` is injectable so tests can simulate window rollover.
export const createRateLimiter = ({ windowMs, maxMessages, maxBytes }) => {

  let windowStart = 0;
  let messageCount = 0;
  let byteCount = 0;

  return {
    allow(bytes, now = Date.now()) {
      if (now - windowStart >= windowMs) {
        windowStart = now;
        messageCount = 0;
        byteCount = 0;
      }

      messageCount += 1;
      byteCount += bytes;

      return (messageCount <= maxMessages && byteCount <= maxBytes);
    }
  };

};

export const logEvent = (source, message, level) => {
  if (
    level !== 'debug'
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

export const getTime = () => {
  return (new Date().getTime());
};

export const isString = (value) => {
  return (
    value &&
    Object.prototype.toString.call(value) === '[object String]' ?
    true :
    false
  );
};

export const isArray = (value) => {
  return (
    value &&
    Object.prototype.toString.call(value) === '[object Array]' ?
    true :
    false
  );
};

export const isObject = (value) => {
  return (
    value &&
    Object.prototype.toString.call(value) === '[object Object]' ?
    true :
    false
  );
};

// History backlog cap policy (max entry size / max count / max total bytes), extracted as a
// pure helper so it stays unit-testable without a Durable Object runtime.
// Mutates `backlog` in place; returns false when the entry is rejected outright.
export const appendToHistoryBacklog = (backlog, entry, { maxMessages, maxBytes, maxEntryBytes }) => {

  if (!isString(entry) || entry.length > maxEntryBytes) {
    return (false);
  }

  backlog.push(entry);

  while (backlog.length > maxMessages) {
    backlog.shift();
  }

  let totalBytes = backlog.reduce((sum, item) => sum + item.length, 0);
  while (totalBytes > maxBytes && backlog.length > 0) {
    const removed = backlog.shift();
    totalBytes -= removed ? removed.length : 0;
  }

  return (true);

};

// WebSocket attachments survive Durable Object hibernation as structured-clone snapshots.
// pack/unpack pin the schema: the 32-byte AES link key (Buffer) travels as base64, the rest
// as plain scalars.
export const packClientAttachment = (client) => {
  return ({
    clientId: client.clientId,
    shared: client.shared ? client.shared.toString('base64') : null,
    channel: client.channel || null,
    expectedRoomHash: client.expectedRoomHash || null,
    seen: client.seen || 0
  });
};

// Returns null when the attachment is malformed; callers should treat the socket as
// unrecoverable and close it (the client will reconnect with a fresh handshake).
export const unpackClientAttachment = (attachment) => {

  if (!isObject(attachment) || !isString(attachment.clientId)) {
    return (null);
  }

  let shared = null;
  if (attachment.shared !== null && attachment.shared !== undefined) {
    if (!isString(attachment.shared)) {
      return (null);
    }
    shared = Buffer.from(attachment.shared, 'base64');
    if (shared.length !== 32) {
      return (null);
    }
  }

  return ({
    clientId: attachment.clientId,
    shared: shared,
    channel: isString(attachment.channel) ? attachment.channel : null,
    expectedRoomHash: isString(attachment.expectedRoomHash) ? attachment.expectedRoomHash : null,
    seen: typeof attachment.seen === 'number' && Number.isFinite(attachment.seen) ? attachment.seen : 0
  });

};

// Note: Since Cloudflare Workers don't have access to global.gc,
// we're not including the garbage collection interval that's in server.js
// setInterval(() => {
//   if (global.gc) {
//     global.gc();
//   }
// }, 30000);
