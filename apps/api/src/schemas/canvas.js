const { z } = require('zod');
const { zB64Bytes, zB64Len, zObjectId } = require('../utils/b64');

// 64k base64 chars ~ 48 KB of ciphertext: room for a 1500-point stroke with padding.
const opSchema = z.object({
  canvasId: zObjectId,
  clientOpId: z.string().uuid(),
  deviceId: zObjectId,
  keyVersion: z.number().int().min(1),
  nonce: zB64Bytes(24),
  ciphertext: zB64Len(24, 64000),
}).strict();
const restOpSchema = opSchema.omit({ canvasId: true });

const liveSchema = z.object({
  canvasId: zObjectId,
  keyVersion: z.number().int().min(1),
  nonce: zB64Bytes(24),
  ciphertext: zB64Len(24, 8000),
}).strict();

const joinSchema = z.object({ canvasId: zObjectId }).strict();
const listOpsSchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
}).strict();
const favoriteSchema = z.object({ favorite: z.boolean() }).strict();

module.exports = { opSchema, restOpSchema, liveSchema, joinSchema, listOpsSchema, favoriteSchema };
