// End-to-end encryption primitives. All crypto is libsodium; nothing here is hand-rolled
// except encoding (base32) and padding, which are covered by tests.
//
//  - Device identity: X25519 keypair (crypto_box). Public key goes to the server.
//  - Room key: random 256-bit key shared by the two partners. Wrapped per device with
//    crypto_box_easy (authenticated: the receiver knows which device wrapped it).
//  - Payloads: XChaCha20-Poly1305 with AAD binding ciphertext to couple/sender/message/keyVersion/kind,
//    so the server cannot replay, re-attribute or move a ciphertext.
//  - Recovery: random 256-bit recovery key encrypts the user's room keys into an opaque blob.
const sodium = require('libsodium-wrappers');

const B64 = () => sodium.base64_variants.ORIGINAL;
const b64 = (u8) => sodium.to_base64(u8, B64());
const unb64 = (s) => sodium.from_base64(s, B64());
const PAD_BLOCK = 128;

async function ready() {
  await sodium.ready;
}

// ---------- device keys ----------
function generateDeviceKeyPair() {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: b64(kp.publicKey), secretKey: kp.privateKey }; // keep secretKey local only
}

// ---------- room key wrapping ----------
const generateRoomKey = () => sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);

function wrapRoomKey(roomKey, recipientPublicKeyB64, senderSecretKey) {
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const ct = sodium.crypto_box_easy(roomKey, nonce, unb64(recipientPublicKeyB64), senderSecretKey);
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

// senderPublicKeyB64 must come from the device registry (and be fingerprint-verified), not from the envelope.
function unwrapRoomKey(envelope, senderPublicKeyB64, recipientSecretKey) {
  return sodium.crypto_box_open_easy(unb64(envelope.ciphertext), unb64(envelope.nonce), unb64(senderPublicKeyB64), recipientSecretKey);
}

// ---------- padding (ISO/IEC 7816-4) hides exact message length ----------
function pad(bytes) {
  const total = Math.ceil((bytes.length + 1) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;
  return out;
}
function unpad(bytes) {
  let i = bytes.length - 1;
  while (i >= 0 && bytes[i] === 0) i--;
  if (i < 0 || bytes[i] !== 0x80) throw new Error('bad padding');
  return bytes.slice(0, i);
}

// ---------- message payloads ----------
function buildAad({ coupleId, senderId, clientMsgId, keyVersion, kind }) {
  return sodium.from_string(`couples-msg-v1|${coupleId}|${senderId}|${clientMsgId}|${keyVersion}|${kind}`);
}

function encryptPayload(roomKey, payload, aadFields) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plain = pad(sodium.from_string(JSON.stringify(payload)));
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, buildAad(aadFields), null, nonce, roomKey);
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}

function decryptPayload(roomKey, { nonce, ciphertext }, aadFields) {
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(ciphertext), buildAad(aadFields), unb64(nonce), roomKey);
  return JSON.parse(sodium.to_string(unpad(plain)));
}

// ---------- generic payloads with a caller-supplied AAD string (canvas ops, live previews, ...) ----------
function encryptRaw(roomKey, payload, aadString) {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const plain = pad(sodium.from_string(JSON.stringify(payload)));
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, sodium.from_string(aadString), null, nonce, roomKey);
  return { nonce: b64(nonce), ciphertext: b64(ct) };
}
function decryptRaw(roomKey, { nonce, ciphertext }, aadString) {
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, unb64(ciphertext), sodium.from_string(aadString), unb64(nonce), roomKey);
  return JSON.parse(sodium.to_string(unpad(plain)));
}

// ---------- safety number (compare out of band to detect a swapped key) ----------
function safetyNumber(publicKeysB64) {
  const material = `couples-safety-v1|${[...publicKeysB64].sort().join('|')}`;
  const h = sodium.crypto_generichash(32, sodium.from_string(material));
  const groups = [];
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 4] << 24) >>> 0) + (h[i * 4 + 1] << 16) + (h[i * 4 + 2] << 8) + h[i * 4 + 3];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ---------- recovery key ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid recovery key character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}
const generateRecoveryKey = () => sodium.randombytes_buf(32);
const formatRecoveryKey = (key) => base32Encode(key).match(/.{1,4}/g).join('-'); // 13 groups
function parseRecoveryKey(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 52) throw new Error('recovery key has wrong length');
  const bytes = base32Decode(clean);
  if (bytes.length < 32) throw new Error('recovery key too short');
  return bytes.slice(0, 32);
}

// roomKeys: { "1": Uint8Array, "2": Uint8Array, ... }
function createRecoveryBlob(recoveryKey, roomKeys, userId) {
  const obj = { v: 1, roomKeys: Object.fromEntries(Object.entries(roomKeys).map(([k, v]) => [k, b64(v)])) };
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    pad(sodium.from_string(JSON.stringify(obj))), sodium.from_string(`couples-recovery-v1|${userId}`), null, nonce, recoveryKey);
  return { version: 1, nonce: b64(nonce), ciphertext: b64(ct) };
}
function openRecoveryBlob(recoveryKey, blob, userId) {
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, unb64(blob.ciphertext), sodium.from_string(`couples-recovery-v1|${userId}`), unb64(blob.nonce), recoveryKey);
  const obj = JSON.parse(sodium.to_string(unpad(plain)));
  return Object.fromEntries(Object.entries(obj.roomKeys).map(([k, v]) => [k, unb64(v)]));
}

module.exports = {
  toBase64: b64, fromBase64: unb64,
  ready, generateDeviceKeyPair, generateRoomKey, wrapRoomKey, unwrapRoomKey,
  buildAad, encryptPayload, decryptPayload, encryptRaw, decryptRaw, safetyNumber,
  generateRecoveryKey, formatRecoveryKey, parseRecoveryKey, createRecoveryBlob, openRecoveryBlob,
  _internal: { pad, unpad, base32Encode, base32Decode },
};
