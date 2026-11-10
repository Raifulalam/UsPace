const { z } = require('zod');
const { zB64Bytes, zB64Len } = require('../utils/b64');

const callId = z.string().uuid();
const startSchema = z.object({ callId, type: z.enum(['audio', 'video']) }).strict();
const idSchema = z.object({ callId }).strict();
// Setup messages are encrypted with the room key; 24k base64 chars is plenty for an SDP.
const signalSchema = z.object({ callId, keyVersion: z.number().int().min(1), nonce: zB64Bytes(24), ciphertext: zB64Len(24, 24000) }).strict();
const historyQuery = z.object({ before: z.string().regex(/^[a-f0-9]{24}$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
module.exports = { startSchema, idSchema, signalSchema, historyQuery };
