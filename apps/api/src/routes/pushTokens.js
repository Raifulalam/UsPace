const router = require('express').Router();
const { z } = require('zod');
const PushToken = require('../models/PushToken');
const Device = require('../models/Device');
const AppError = require('../utils/AppError');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');

const registerSchema = z.object({
  token: z.string().trim().min(1).max(4096),
  deviceId: zObjectId,
  platform: z.literal('android').default('android'),
}).strict();
const deleteSchema = z.object({
  token: z.string().trim().min(1).max(4096),
  deviceId: zObjectId.optional(),
}).strict();

router.use(authenticate);

router.post('/', validate(registerSchema), asyncHandler(async (req, res) => {
  const device = await Device.findOne({ _id: req.body.deviceId, userId: req.user._id, revokedAt: null }).select('_id');
  if (!device) throw new AppError(403, 'DEVICE_INVALID', 'This device is not registered or was revoked');
  try {
    const token = await PushToken.findOneAndUpdate(
      { userId: req.user._id, deviceId: device._id },
      { $set: { token: req.body.token, platform: req.body.platform, lastSeenAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(200).json({ data: { pushToken: { deviceId: String(token.deviceId), platform: token.platform } } });
  } catch (e) {
    if (e.code === 11000) throw new AppError(409, 'PUSH_TOKEN_EXISTS', 'This push token is already registered');
    throw e;
  }
}));

router.delete('/', validate(deleteSchema), asyncHandler(async (req, res) => {
  const filter = { userId: req.user._id, token: req.body.token };
  if (req.body.deviceId) filter.deviceId = req.body.deviceId;
  await PushToken.deleteOne(filter);
  res.status(204).end();
}));

module.exports = router;
