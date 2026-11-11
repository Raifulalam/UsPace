const Device = require('../models/Device');
const Couple = require('../models/Couple');
const RoomKeyEnvelope = require('../models/RoomKeyEnvelope');
const RecoveryBlob = require('../models/RecoveryBlob');
const AppError = require('../utils/AppError');
const { requireActiveCouple } = require('./access');
const { emitToCouple } = require('./realtime');

const MAX_DEVICES = 10;
const MAX_ENVELOPES = 200;
const now = () => new Date();

const deviceView = (d, me) => ({ id: d.id, userId: String(d.userId), publicKey: d.publicKey, label: d.label, isMine: me ? String(d.userId) === String(me._id) : undefined, createdAt: d.createdAt });

async function registerDevice(user, { publicKey, label }) {
  if ((await Device.countDocuments({ userId: user._id, revokedAt: null })) >= MAX_DEVICES) {
    throw new AppError(429, 'TOO_MANY_DEVICES', `You have reached the limit of ${MAX_DEVICES} active devices. Remove a device first`);
  }
  try {
    const device = await Device.create({ userId: user._id, publicKey, label });
    // Tell the other device(s) in the room so a trusted device can show the "approve" banner immediately.
    if (user.coupleId) emitToCouple(String(user.coupleId), 'keys:updated', { reason: 'device-added' });
    return device;
  } catch (e) {
    if (e.code === 11000) throw new AppError(409, 'DEVICE_EXISTS', 'This device key is already registered');
    throw e;
  }
}

const listMyDevices = (user) => Device.find({ userId: user._id, revokedAt: null }).sort({ createdAt: 1 });

// Revoking bumps the couple's keyVersion: the old key is considered compromised for FUTURE messages.
// Clients must upload envelopes for the new version before anyone can send again.
async function revokeDevice(user, id) {
  const d = await Device.findOneAndUpdate({ _id: id, userId: user._id, revokedAt: null }, { $set: { revokedAt: now() } }, { new: true });
  if (!d) throw new AppError(404, 'DEVICE_NOT_FOUND', 'No such device');
  let keyVersion = null;
  if (user.coupleId) {
    emitToCouple(String(user.coupleId), 'keys:updated', { reason: 'device-removed' });
    const c = await Couple.findOneAndUpdate({ _id: user.coupleId, members: user._id, status: 'active' }, { $inc: { keyVersion: 1 } }, { new: true });
    keyVersion = c ? c.keyVersion : null;
  }
  return { device: d, keyVersion };
}

async function listCoupleDevices(user) {
  const couple = await requireActiveCouple(user);
  const devices = await Device.find({ userId: { $in: couple.members }, revokedAt: null }).sort({ createdAt: 1 });
  // hasKey: this device already holds an envelope for the CURRENT key version.
  const have = new Set(
    (await RoomKeyEnvelope.find({ coupleId: couple._id, keyVersion: couple.keyVersion, deviceId: { $in: devices.map((d) => d._id) } }).select('deviceId')).map((e) => String(e.deviceId))
  );
  return { keyVersion: couple.keyVersion, devices: devices.map((d) => ({ ...deviceView(d, user), hasKey: have.has(d.id) })) };
}

async function putEnvelopes(user, { senderDeviceId, envelopes }) {
  const couple = await requireActiveCouple(user);
  if (envelopes.length > MAX_ENVELOPES) throw new AppError(400, 'TOO_MANY', 'Too many envelopes');
  const sender = await Device.findOne({ _id: senderDeviceId, userId: user._id, revokedAt: null });
  if (!sender) throw new AppError(403, 'DEVICE_INVALID', 'Sender device is not yours or is revoked');
  if (envelopes.some((e) => e.keyVersion > couple.keyVersion)) throw new AppError(400, 'BAD_KEY_VERSION', 'keyVersion is ahead of the room');

  const ids = [...new Set(envelopes.map((e) => e.deviceId))];
  const recipients = await Device.find({ _id: { $in: ids }, userId: { $in: couple.members }, revokedAt: null }).select('_id');
  if (recipients.length !== ids.length) throw new AppError(400, 'BAD_RECIPIENT', 'Every recipient must be an active device of a room member');

  // Trust rule: a version that already has envelopes can only be extended by a device that holds it. A brand-new
  // version (v1 bootstrap, or a rotation) may only be created by a device that held the previous version.
  // This stops an unapproved or stolen-session device from handing out a key of its own choosing.
  const holds = (version) => RoomKeyEnvelope.exists({ coupleId: couple._id, keyVersion: version, deviceId: sender._id });
  for (const v of new Set(envelopes.map((e) => e.keyVersion))) {
    const existing = await RoomKeyEnvelope.countDocuments({ coupleId: couple._id, keyVersion: v });
    const ok = existing > 0 ? await holds(v) : v === 1 ? true : await holds(v - 1);
    if (!ok) throw new AppError(403, 'NOT_TRUSTED', 'This device has not been approved for that key version');
  }

  // $setOnInsert + upsert: an existing envelope is never overwritten.
  const res = await RoomKeyEnvelope.bulkWrite(
    envelopes.map((e) => ({
      updateOne: {
        filter: { coupleId: couple._id, keyVersion: e.keyVersion, deviceId: e.deviceId },
        update: { $setOnInsert: { senderDeviceId: sender._id, nonce: e.nonce, ciphertext: e.ciphertext } },
        upsert: true,
      },
    }))
  );
  if (res.upsertedCount > 0) emitToCouple(String(couple._id), 'keys:updated', { keyVersion: couple.keyVersion });
  return { stored: res.upsertedCount, keyVersion: couple.keyVersion };
}

async function getEnvelopes(user, deviceId) {
  const couple = await requireActiveCouple(user);
  const device = await Device.findOne({ _id: deviceId, userId: user._id, revokedAt: null });
  if (!device) throw new AppError(404, 'DEVICE_NOT_FOUND', 'No such device');
  const envs = await RoomKeyEnvelope.find({ coupleId: couple._id, deviceId: device._id }).sort({ keyVersion: 1 });
  const senders = await Device.find({ _id: { $in: envs.map((e) => e.senderDeviceId) } }); // includes revoked: needed to open old keys
  const pub = Object.fromEntries(senders.map((s) => [s.id, s.publicKey]));
  return {
    keyVersion: couple.keyVersion,
    envelopes: envs.map((e) => ({ keyVersion: e.keyVersion, senderDeviceId: String(e.senderDeviceId), senderPublicKey: pub[String(e.senderDeviceId)], nonce: e.nonce, ciphertext: e.ciphertext })),
  };
}

async function putRecovery(user, { version, nonce, ciphertext }) {
  await RecoveryBlob.findOneAndUpdate({ userId: user._id }, { $set: { version, nonce, ciphertext } }, { upsert: true, new: true });
}
async function getRecovery(user) {
  const r = await RecoveryBlob.findOne({ userId: user._id });
  if (!r) throw new AppError(404, 'NO_RECOVERY', 'No recovery backup stored');
  return { version: r.version, nonce: r.nonce, ciphertext: r.ciphertext, updatedAt: r.updatedAt };
}
const deleteRecovery = (user) => RecoveryBlob.deleteOne({ userId: user._id });

module.exports = { deviceView, registerDevice, listMyDevices, revokeDevice, listCoupleDevices, putEnvelopes, getEnvelopes, putRecovery, getRecovery, deleteRecovery };
