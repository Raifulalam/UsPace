const Message = require('../models/Message');
const Device = require('../models/Device');
const AppError = require('../utils/AppError');
const { requireActiveCouple } = require('./access');
const media = require('./mediaService');
const Couple = require('../models/Couple');
const User = require('../models/User');
const MessageReaction = require('../models/MessageReaction');
const ReadState = require('../models/ReadState');
const mongoose = require('mongoose');
const realtime = require('./realtime');

const MAX_PINNED = 5;
const EDIT_WINDOW_MS = 24 * 3600 * 1000;
const reactionView = (r) => ({ messageId: String(r.messageId), userId: String(r.userId), keyVersion: r.keyVersion, nonce: r.nonce, ciphertext: r.ciphertext });

const view = (m) => ({
  id: m.id, senderId: String(m.senderId), senderDeviceId: String(m.senderDeviceId), clientMsgId: m.clientMsgId,
  keyVersion: m.keyVersion, kind: m.kind, deleted: Boolean(m.deletedAt), editedAt: m.editedAt || null, pinned: Boolean(m.pinnedAt && !m.deletedAt), mediaIds: (m.mediaIds || []).map(String),
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
  // The room's disappearing-message timer is enforced here, so a client can never forget (or choose a longer lifetime).
  const roomTtl = couple.messageTtlSec || 0;
  const seconds = roomTtl ? Math.min(input.expiresInSec || roomTtl, roomTtl) : input.expiresInSec || 0;
  try {
    const doc = await Message.create({
      coupleId: couple._id, senderId: user._id, senderDeviceId: device._id, clientMsgId: input.clientMsgId,
      keyVersion: input.keyVersion, kind: input.kind, nonce: input.nonce, ciphertext: input.ciphertext, mediaIds: input.mediaIds || [],
      expiresAt: seconds ? new Date(Date.now() + seconds * 1000) : undefined,
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
  const reactions = page.length ? await MessageReaction.find({ messageId: { $in: page.map((m) => m._id) } }) : [];
  return { messages: page.map(view), reactions: reactions.map(reactionView), nextCursor: rows.length > limit ? page[page.length - 1].id : null };
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
  await MessageReaction.deleteMany({ messageId: m._id });
  return { message: view(m), coupleId: String(couple._id) };
}

const live = (messageId, coupleId) => Message.findOne({ _id: messageId, coupleId, deletedAt: null });

/** The sender may change their own text/caption for 24 hours. The new ciphertext replaces the old one; the server never sees either. */
async function editMessage(user, id, input) {
  const couple = await requireActiveCouple(user);
  if (input.keyVersion !== couple.keyVersion) throw new AppError(409, 'KEY_VERSION_STALE', 'The room key changed; fetch the new key and retry', { currentKeyVersion: couple.keyVersion });
  const m = await Message.findOne({ _id: id, coupleId: couple._id, senderId: user._id, deletedAt: null });
  if (!m) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  if (!['text', 'media'].includes(m.kind)) throw new AppError(409, 'NOT_EDITABLE', 'This kind of message cannot be edited');
  if (Date.now() - m.createdAt.getTime() > EDIT_WINDOW_MS) throw new AppError(403, 'EDIT_WINDOW_CLOSED', 'Messages can be edited for 24 hours');
  const updated = await Message.findOneAndUpdate({ _id: m._id, deletedAt: null }, { $set: { keyVersion: input.keyVersion, nonce: input.nonce, ciphertext: input.ciphertext, editedAt: new Date() } }, { new: true });
  if (!updated) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  realtime.emitToCouple(String(couple._id), 'message:edited', view(updated));
  return view(updated);
}

// Either partner can pin; at most five pinned messages per room.
async function setPinned(user, id, pinned) {
  const couple = await requireActiveCouple(user);
  const m = await live(id, couple._id);
  if (!m) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  if (pinned && !m.pinnedAt && (await Message.countDocuments({ coupleId: couple._id, pinnedAt: { $ne: null }, deletedAt: null })) >= MAX_PINNED) {
    throw new AppError(409, 'TOO_MANY_PINNED', `You can pin up to ${MAX_PINNED} messages. Unpin one first.`);
  }
  const updated = await Message.findOneAndUpdate({ _id: m._id, deletedAt: null }, pinned ? { $set: { pinnedAt: m.pinnedAt || new Date(), pinnedBy: user._id } } : { $unset: { pinnedAt: 1, pinnedBy: 1 } }, { new: true });
  realtime.emitToCouple(String(couple._id), 'message:pinned', { id: String(m._id), pinned });
  return view(updated);
}
async function listPinned(user) {
  const couple = await requireActiveCouple(user);
  return (await Message.find({ coupleId: couple._id, pinnedAt: { $ne: null }, deletedAt: null }).sort({ pinnedAt: -1 })).map(view);
}

async function setReaction(user, id, input) {
  const couple = await requireActiveCouple(user);
  if (input.keyVersion !== couple.keyVersion) throw new AppError(409, 'KEY_VERSION_STALE', 'The room key changed; fetch the new key and retry', { currentKeyVersion: couple.keyVersion });
  const m = await live(id, couple._id);
  if (!m) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  const r = await MessageReaction.findOneAndUpdate(
    { messageId: m._id, userId: user._id },
    { $set: { coupleId: couple._id, keyVersion: input.keyVersion, nonce: input.nonce, ciphertext: input.ciphertext } },
    { upsert: true, new: true }
  );
  realtime.emitToCouple(String(couple._id), 'message:reaction', reactionView(r));
  return reactionView(r);
}
async function removeReaction(user, id) {
  const couple = await requireActiveCouple(user);
  await MessageReaction.deleteOne({ messageId: id, userId: user._id, coupleId: couple._id });
  realtime.emitToCouple(String(couple._id), 'message:reaction', { messageId: String(id), userId: String(user._id), removed: true });
}

// ---------- read state: unread counts and "seen" ----------
async function markRead(user, upTo) {
  const couple = await requireActiveCouple(user);
  if (!(await Message.exists({ _id: upTo, coupleId: couple._id }))) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message');
  const fresh = await User.findById(user._id).select('readReceipts');
  // $max: reading an older message never moves you backwards.
  const rs = await ReadState.findOneAndUpdate({ coupleId: couple._id, userId: user._id }, { $max: { lastReadId: upTo } }, { upsert: true, new: true });
  if (fresh.readReceipts !== false) realtime.emitToCouple(String(couple._id), 'message:read', { userId: String(user._id), upTo: String(rs.lastReadId) });
  return { lastReadId: String(rs.lastReadId) };
}

async function readState(user) {
  const couple = await requireActiveCouple(user);
  const partnerId = couple.members.find((x) => !x.equals(user._id));
  const [mine, theirs, me, partner] = await Promise.all([
    ReadState.findOne({ coupleId: couple._id, userId: user._id }),
    partnerId ? ReadState.findOne({ coupleId: couple._id, userId: partnerId }) : null,
    User.findById(user._id).select('readReceipts'),
    partnerId ? User.findById(partnerId).select('readReceipts') : null,
  ]);
  const floor = mine?.lastReadId ?? new mongoose.Types.ObjectId('000000000000000000000000');
  const unread = await Message.countDocuments({
    coupleId: couple._id, senderId: { $ne: user._id }, deletedAt: null, _id: { $gt: floor },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
  });
  // "Seen" is reciprocal: if either of you turned read receipts off, neither sees the other's progress.
  const shared = me.readReceipts !== false && partner?.readReceipts !== false;
  return { mine: mine?.lastReadId ? String(mine.lastReadId) : null, partner: shared && theirs?.lastReadId ? String(theirs.lastReadId) : null, unread, receiptsEnabled: shared };
}

module.exports = { sendMessage, listMessages, deleteMessage, view, editMessage, setPinned, listPinned, setReaction, removeReaction, markRead, readState };
