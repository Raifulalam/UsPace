// Authenticated encryption (AES-256-GCM) for secrets stored in the database, such as admins' authenticator seeds.
// A database leak alone then cannot be used to generate admin login codes: the key lives only in the server's environment.
const crypto = require('crypto');

const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest();
function seal(plaintext, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
}
function open(sealed, secret) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad sealed value');
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
module.exports = { seal, open };
