// Server link protocol v2: HKDF-SHA256 key derivation + AES-256-GCM envelopes.
// Zero-dependency on purpose: runs in browsers and Node >= 20 via globalThis.crypto.
// 服务端通道协议 v2：HKDF-SHA256 派生密钥 + AES-256-GCM 信封。
// 刻意零依赖：通过 globalThis.crypto 同时支持浏览器与 Node >= 20。

// Both sides must use identical HKDF parameters (see worker/index.js).
// 双方必须使用完全一致的 HKDF 参数（见 worker/index.js）。
const HKDF_SALT = 'nodecrypt-server-link-v2';
const HKDF_INFO = 'aes-256-gcm';
const IV_BYTES = 12;
const BASE64_CHUNK = 0x8000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Prefer native codecs (Uint8Array#toBase64 / Uint8Array.fromBase64) when the engine has them:
// canonical RFC 4648 output identical to the btoa/atob path, ~8x faster on multi-hundred-KB payloads.
// 引擎支持时优先用原生编解码（toBase64/fromBase64）：输出与 btoa/atob 路径完全一致（RFC 4648 规范形式），
// 数百 KB 级负载下约快 8 倍。
const HAS_NATIVE_BASE64 = typeof Uint8Array.prototype.toBase64 === 'function' && typeof Uint8Array.fromBase64 === 'function';

// Chunked conversion keeps String.fromCharCode below engine argument limits for large payloads.
// 分块转换可避免大负载超出引擎的 String.fromCharCode 参数上限。
export function bytesToBase64(bytes) {
	if (HAS_NATIVE_BASE64) {
		return bytes.toBase64()
	}
	let binary = '';
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK))
	}
	return btoa(binary)
}

export function base64ToBytes(value) {
	if (HAS_NATIVE_BASE64) {
		return Uint8Array.fromBase64(value)
	}
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

// Derive the AES-256-GCM link key from the full 384-bit ECDH shared secret.
// 从完整的 384 位 ECDH 共享秘密派生 AES-256-GCM 通道密钥。
export async function deriveServerLinkKey(sharedBits) {
	const ikm = sharedBits instanceof Uint8Array ? sharedBits : new Uint8Array(sharedBits);
	const baseKey = await globalThis.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
	return globalThis.crypto.subtle.deriveKey({
		name: 'HKDF',
		hash: 'SHA-256',
		salt: textEncoder.encode(HKDF_SALT),
		info: textEncoder.encode(HKDF_INFO)
	}, baseKey, {
		name: 'AES-GCM',
		length: 256
	}, false, ['encrypt', 'decrypt'])
}

// Envelope format: base64(iv) + '|' + base64(ciphertext || 16-byte GCM tag). Returns null on failure.
// 信封格式：base64(iv) + '|' + base64(密文 || 16 字节 GCM tag)。失败返回 null。
export async function encryptServerEnvelope(obj, key) {
	try {
		const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const ciphertext = await globalThis.crypto.subtle.encrypt({
			name: 'AES-GCM',
			iv: iv
		}, key, textEncoder.encode(JSON.stringify(obj)));
		return bytesToBase64(iv) + '|' + bytesToBase64(new Uint8Array(ciphertext))
	} catch {
		return null
	}
}

// Returns the parsed object, or null on any failure (malformed envelope, bad tag, bad JSON).
// 返回解析后的对象；任何失败（信封损坏、tag 校验失败、JSON 非法）都返回 null，不抛异常。
export async function decryptServerEnvelope(str, key) {
	try {
		if (typeof str !== 'string' && !(str instanceof String)) {
			return null
		}
		const parts = str.split('|');
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			return null
		}
		const iv = base64ToBytes(parts[0]);
		if (iv.length !== IV_BYTES) {
			return null
		}
		const plaintext = await globalThis.crypto.subtle.decrypt({
			name: 'AES-GCM',
			iv: iv
		}, key, base64ToBytes(parts[1]));
		return JSON.parse(textDecoder.decode(plaintext))
	} catch {
		return null
	}
}
