const Message = require('../models/Message');
const Device = require('../models/Device');
const AppError = require('../utils/AppError');
const { requireActiveCouple } = require('./access');
const media = require('./mediaService');

const view = (m) => ({
  id: m.id, senderId: String(m.senderId), senderDeviceId: String(m.senderDeviceId), clientMsgId: m.clientMsgId,
  keyVersion: m.keyVersion, kind: m.kind, deleted: Boolean(m.deletedAt), mediaIds: (m.mediaIds || []).map(String),
  nonce: m.deletedAt ? null : m.nonce, ciphertext: m.deletedAt ? null : m.ciphertext,
  expiresAt: m.expiresAt || null, createdAt: m.createdAt,
});

async function sendMessage(user, input) {
  const couple = await requireActiveCouple(user);
  const device = await Device.findOne({ _id: input.deviceId, userId: user._id, revokedAt: null });
  if (!device) throw new AppError(403, 'DEVICE_INVALID', 'This device is not registered or was revoked');
  if (input.keyVersion !== couple.keyVersion) {
    throw new AppError(409, 'KEY_VERSION_STALE', 'The room key changed; fetch the new key and retry', { currentKeyVersion: couple.keyVersion });
  }
  if (input.mediaIds && input.mediaIds.length) await media.assertAttachable(couple._id, input.mediaIds);
  try {
    const doc = await Message.create({
      coupleId: couple._id, senderId: user._id, senderDeviceId: device._id, clientMsgId: input.clientMsgId,
      keyVersion: input.keyVersion, kind: input.kind, nonce: input.nonce, ciphertext: input.ciphertext, mediaIds: input.mediaIds || [],
      expiresAt: input.expiresInSec ? new Date(Date.now() + input.expiresInSec * 1000) : undefined,
    });
    return { message: view(doc), created: true, coupleId: String(couple._id) };
  } catch (e) {
    if (e.code === 11000) {
      const existing = await Message.findOne({ senderId: user._id, clientMsgId: input.clientMsgId, coupleId: couple._id });
      if (existing) return { message: view(existing), created: false, coupleId: String(couple._id) };
    }
    throw e;
  }
}

async function listMessages(user, { before, limit }) {
  const couple = await requireActiveCouple(user);
  const q = { coupleId: couple._id, $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }] };
  if (before) q._id = { $lt: before };
  const rows = await Message.find(q).sort({ _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { messages: page.map(view), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
}

// Sender-only tombstone: ciphertext is wiped from the server.
async function deleteMessage(user, id) {
  const couple = await requireActiveCouple(user);
  const m = await Message.findOneAndUpdate(
    { _id: id, coupleId: couple._id, senderId: user._id, deletedAt: null },
    { $set: { deletedAt: new Date() }, $unset: { ciphertext: 1, nonce: 1 } },
    { new: true }
  );
  if (!m) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  await media.releaseIfUnreferenced(couple._id, m.mediaIds); // files only this message used are deleted and the quota refunded
  return { message: view(m), coupleId: String(couple._id) };
}

module.exports = { sendMessage, listMessages, deleteMessage, view };
