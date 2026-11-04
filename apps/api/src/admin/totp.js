// RFC 6238 time-based one-time passwords (what Google Authenticator, 1Password, Authy etc. implement).
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = (bytes = 20) => base32Encode(crypto.randomBytes(bytes));

function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % Math.pow(10, digits)).padStart(digits, '0');
}
const stepAt = (timeMs, step = 30) => Math.floor(timeMs / 1000 / step);
const totp = (secretB32, timeMs = Date.now(), { step = 30, digits = 6 } = {}) => hotp(base32Decode(secretB32), stepAt(timeMs, step), digits);

const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Returns the matching time step, or null. A step at or below `lastUsedStep` is refused, so a code
 * (even a correct one) can never be used twice, which stops replay of an observed code.
 */
function verifyTotp(secretB32, code, { timeMs = Date.now(), window = 1, step = 30, digits = 6, lastUsedStep = -1 } = {}) {
  if (!/^\d+$/.test(String(code)) || String(code).length !== digits) return null;
  const secret = base32Decode(secretB32);
  const now = stepAt(timeMs, step);
  for (let w = -window; w <= window; w++) {
    const s = now + w;
    if (s <= lastUsedStep) continue;
    if (safeEqual(hotp(secret, s, digits), String(code))) return s;
  }
  return null;
}

const otpauthUri = ({ secret, account, issuer }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Single-use backup codes for a lost phone. Only their hashes are stored.
function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
const normalizeRecovery = (c) => String(c).toUpperCase().replace(/[^A-Z2-7]/g, '');
const hashRecovery = (c) => crypto.createHash('sha256').update(normalizeRecovery(c)).digest('hex');

module.exports = { base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, stepAt, otpauthUri, generateRecoveryCodes, hashRecovery, normalizeRecovery };
