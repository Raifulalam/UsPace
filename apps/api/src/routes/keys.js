const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zB64Bytes, zB64Len, zObjectId } = require('../utils/b64');
const keys = require('../services/keyService');

// A crypto_box-wrapped 32-byte key is 32 + 16 (MAC) = 48 bytes.
const putEnvSchema = z.object({
  senderDeviceId: zObjectId,
  envelopes: z.array(z.object({ keyVersion: z.number().int().min(1), deviceId: zObjectId, nonce: zB64Bytes(24), ciphertext: zB64Bytes(48) }).strict()).min(1).max(200),
}).strict();
const getEnvQuery = z.object({ deviceId: zObjectId }).strict();
const recoverySchema = z.object({ version: z.literal(1), nonce: zB64Bytes(24), ciphertext: zB64Len(40, 90000) }).strict();
router.use(authenticate);

router.get('/couple-devices', asyncHandler(async (req, res) => res.json({ data: await keys.listCoupleDevices(req.user) })));
router.put('/envelopes', validate(putEnvSchema), asyncHandler(async (req, res) => res.json({ data: await keys.putEnvelopes(req.user, req.body) })));
router.get('/envelopes', validate(getEnvQuery, 'query'), asyncHandler(async (req, res) => res.json({ data: await keys.getEnvelopes(req.user, req.query.deviceId) })));

router.put('/recovery', validate(recoverySchema), asyncHandler(async (req, res) => { await keys.putRecovery(req.user, req.body); res.status(204).end(); }));
router.get('/recovery', asyncHandler(async (req, res) => res.json({ data: await keys.getRecovery(req.user) })));
router.delete('/recovery', asyncHandler(async (req, res) => { await keys.deleteRecovery(req.user); res.status(204).end(); }));

module.exports = router;
