const { z } = require('zod');

// Canonical standard base64 only, so equal bytes always have equal strings.
function decodeExact(s, n) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s && (n == null || buf.length === n);
}
const zB64Bytes = (n) => z.string().refine((s) => decodeExact(s, n), `Must be base64 of exactly ${n} bytes`);
const zB64Len = (min, max) => z.string().min(min).max(max).refine((s) => decodeExact(s, null), 'Must be canonical base64');
const zObjectId = z.string().regex(/^[a-f0-9]{24}$/);

module.exports = { zB64Bytes, zB64Len, zObjectId };
