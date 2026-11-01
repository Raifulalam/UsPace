const User = require('../models/User');
const Couple = require('../models/Couple');
const Device = require('../models/Device');
const RefreshToken = require('../models/RefreshToken');
const RecoveryBlob = require('../models/RecoveryBlob');
const RoomKeyEnvelope = require('../models/RoomKeyEnvelope');
const Invitation = require('../models/Invitation');
const Message = require('../models/Message');
const Canvas = require('../models/Canvas');
const CanvasOp = require('../models/CanvasOp');
const Memory = require('../models/Memory');
const Album = require('../models/Album');
const MediaAsset = require('../models/MediaAsset');
const Block = require('../models/Block');
const { getStorage } = require('../storage');
const { closedCoupleCutoff } = require('../utils/privacy');

/**
 * PERMANENT deletion. What is erased and what is kept:
 *  - closed rooms (30 days after closing): messages, drawings, memories, albums, files (and their stored bytes), key envelopes, invitations, the room itself.
 *  - deleted accounts (after the 14-day grace period): the account, devices, sessions, recovery backup, blocks, invitations.
 *  - KEPT: abuse reports (safety/legal), and admin audit and payment records (added in later phases).
 */
async function purgeCouple(couple) {
  const id = couple._id;
  const assets = await MediaAsset.find({ coupleId: id, status: { $ne: 'deleted' } }).select('storageKey');
  for (const a of assets) await getStorage().delete(a.storageKey).catch(() => {});
  const count = async (p) => (await p).deletedCount;
  const out = {
    messages: await count(Message.deleteMany({ coupleId: id })),
    drawingActions: await count(CanvasOp.deleteMany({ coupleId: id })),
    canvases: await count(Canvas.deleteMany({ coupleId: id })),
    memories: await count(Memory.deleteMany({ coupleId: id })),
    albums: await count(Album.deleteMany({ coupleId: id })),
    files: await count(MediaAsset.deleteMany({ coupleId: id })),
    keyEnvelopes: await count(RoomKeyEnvelope.deleteMany({ coupleId: id })),
    invitations: await count(Invitation.deleteMany({ coupleId: id })),
  };
  await Couple.deleteOne({ _id: id });
  return out;
}

async function purgeUser(user) {
  if (user.status !== 'pending_deletion') return false; // never touch a live account, whatever the caller passes
  if (user.coupleId) { // should already be closed; make sure the partner is never left in a room with a deleted person
    await Couple.updateOne({ _id: user.coupleId, status: { $ne: 'closed' } }, { $set: { status: 'closed', closedAt: new Date(), closedBy: user._id } });
    await User.updateMany({ coupleId: user.coupleId }, { $unset: { coupleId: 1 } });
  }
  await Device.deleteMany({ userId: user._id });
  await RefreshToken.deleteMany({ userId: user._id });
  await RecoveryBlob.deleteMany({ userId: user._id });
  await Block.deleteMany({ $or: [{ blockerId: user._id }, { blockedId: user._id }] });
  await Invitation.deleteMany({ $or: [{ inviterId: user._id }, { inviteeId: user._id }] });
  await User.deleteOne({ _id: user._id, status: 'pending_deletion' });
  return true;
}

async function sweep(now = Date.now()) {
  let couples = 0, users = 0;
  const closed = await Couple.find({ status: 'closed', closedAt: { $lt: closedCoupleCutoff(now) } }).limit(200);
  for (const c of closed) { await purgeCouple(c); couples++; }
  const due = await User.find({ status: 'pending_deletion', deletionScheduledAt: { $lt: new Date(now) } }).limit(200);
  for (const u of due) { await purgeUser(u); users++; }
  return { couples, users };
}

module.exports = { sweep, purgeCouple, purgeUser };
