const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zB64Bytes, zObjectId } = require('../utils/b64');
const keys = require('../services/keyService');
const { notifyCouple } = require('../services/pushNotificationService');

const createSchema = z.object({ publicKey: zB64Bytes(32), label: z.string().trim().min(1).max(60) }).strict();
const idParam = z.object({ id: zObjectId }).strict();
router.use(authenticate);

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const device = await keys.registerDevice(req.user, req.body);
  if (req.user.coupleId) notifyCouple({
    coupleId: req.user.coupleId,
    senderId: req.user._id,
    type: 'device_change',
    title: 'UsPace',
    body: 'A new device joined your shared space.',
    destination: '/space',
    eventId: `device-added:${device.id}`,
  }).catch((error) => console.error('push notification delivery failed', error));
  res.status(201).json({ data: { device: keys.deviceView(device, req.user) } });
}));
router.get('/', asyncHandler(async (req, res) => {
  res.json({ data: { devices: (await keys.listMyDevices(req.user)).map((d) => keys.deviceView(d, req.user)) } });
}));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { keyVersion } = await keys.revokeDevice(req.user, req.params.id);
  if (req.user.coupleId) notifyCouple({
    coupleId: req.user.coupleId,
    senderId: req.user._id,
    type: 'device_change',
    title: 'UsPace',
    body: 'A device was removed from your shared space.',
    destination: '/space',
    eventId: `device-removed:${req.params.id}`,
  }).catch((error) => console.error('push notification delivery failed', error));
  res.json({ data: { keyVersion } });
}));

module.exports = router;
