const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zB64Bytes, zObjectId } = require('../utils/b64');
const keys = require('../services/keyService');

const createSchema = z.object({ publicKey: zB64Bytes(32), label: z.string().trim().min(1).max(60) }).strict();
const idParam = z.object({ id: zObjectId }).strict();
router.use(authenticate);

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  res.status(201).json({ data: { device: keys.deviceView(await keys.registerDevice(req.user, req.body), req.user) } });
}));
router.get('/', asyncHandler(async (req, res) => {
  res.json({ data: { devices: (await keys.listMyDevices(req.user)).map((d) => keys.deviceView(d, req.user)) } });
}));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { keyVersion } = await keys.revokeDevice(req.user, req.params.id);
  res.json({ data: { keyVersion } });
}));

module.exports = router;
