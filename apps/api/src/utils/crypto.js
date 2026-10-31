const crypto = require('crypto');

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

// 30-symbol alphabet without look-alike characters (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
function generateInviteCode() {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
const normalizeInviteCode = (c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
// Hash the normalized form so "abcde-fghjk" and "ABCDEFGHJK" match.
const hashInviteCode = (c) => sha256(normalizeInviteCode(c));

module.exports = { sha256, randomToken, generateInviteCode, hashInviteCode, normalizeInviteCode };
