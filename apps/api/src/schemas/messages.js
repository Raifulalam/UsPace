const { z } = require('zod');
const { zB64Bytes, zB64Len, zObjectId } = require('../utils/b64');

// 16 KB of ciphertext ~ 21.9k base64 chars
const sendSchema = z.object({
  clientMsgId: z.string().uuid(),
  deviceId: zObjectId,
  keyVersion: z.number().int().min(1),
  kind: z.enum(['text', 'media', 'sticker', 'heart']),
  nonce: zB64Bytes(24),
  ciphertext: zB64Len(24, 22000),
  expiresInSec: z.number().int().min(5).max(30 * 86400).optional(),
  mediaIds: z.array(zObjectId).max(4).optional(), // files referenced by this message (plaintext so the server can refcount them)
}).strict();

const listSchema = z.object({
  before: zObjectId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

module.exports = { sendSchema, listSchema };
