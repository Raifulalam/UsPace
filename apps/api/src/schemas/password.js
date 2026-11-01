const { z } = require('zod');

// bcrypt only uses the first 72 BYTES, so longer passwords would silently be truncated: reject them instead.
const passwordSchema = z.string().min(10).refine((p) => Buffer.byteLength(p) <= 72, 'Password too long (max 72 bytes)');
module.exports = { passwordSchema };
