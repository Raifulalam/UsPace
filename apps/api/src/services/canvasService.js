const Canvas = require('../models/Canvas');
const CanvasOp = require('../models/CanvasOp');
const Device = require('../models/Device');
const AppError = require('../utils/AppError');
const { requireActiveCouple } = require('./access');

const MAX_CANVASES = 50;
const MAX_OPS = 20000;

const canvasView = (c, user) => ({
  id: c.id, createdBy: String(c.createdBy), seq: c.seq, opCount: c.opCount,
  favorite: c.favoritedBy.some((u) => String(u) === String(user._id)),
  createdAt: c.createdAt, updatedAt: c.updatedAt,
});
const opView = (o) => ({
  seq: o.seq, clientOpId: o.clientOpId, senderId: String(o.senderId), senderDeviceId: String(o.senderDeviceId),
  keyVersion: o.keyVersion, nonce: o.nonce, ciphertext: o.ciphertext, createdAt: o.createdAt,
});

// Every canvas lookup is scoped by the caller's couple: another couple's canvas id simply does not exist for you.
async function getCanvasForUser(user, canvasId) {
  const couple = await requireActiveCouple(user);
  const canvas = await Canvas.findOne({ _id: canvasId, coupleId: couple._id, archivedAt: null });
  if (!canvas) throw new AppError(404, 'CANVAS_NOT_FOUND', 'No such canvas');
  return { canvas, couple };
}

async function createCanvas(user) {
  const couple = await requireActiveCouple(user);
  if ((await Canvas.countDocuments({ coupleId: couple._id, archivedAt: null })) >= MAX_CANVASES) {
    throw new AppError(409, 'TOO_MANY_CANVASES', 'Delete an old canvas first');
  }
  const c = await Canvas.create({ coupleId: couple._id, createdBy: user._id });
  return canvasView(c, user);
}

async function listCanvases(user) {
  const couple = await requireActiveCouple(user);
  const rows = await Canvas.find({ coupleId: couple._id, archivedAt: null }).sort({ createdAt: 1 });
  return rows.map((c) => canvasView(c, user));
}

async function listOps(user, canvasId, { since, limit }) {
  const { canvas } = await getCanvasForUser(user, canvasId);
  const rows = await CanvasOp.find({ canvasId: canvas._id, seq: { $gt: since } }).sort({ seq: 1 }).limit(limit + 1);
  return { ops: rows.slice(0, limit).map(opView), hasMore: rows.length > limit, seq: canvas.seq };
}

async function appendOp(user, input) {
  const { canvas, couple } = await getCanvasForUser(user, input.canvasId);
  const device = await Device.findOne({ _id: input.deviceId, userId: user._id, revokedAt: null });
  if (!device) throw new AppError(403, 'DEVICE_INVALID', 'This device is not registered or was revoked');
  if (input.keyVersion !== couple.keyVersion) {
    throw new AppError(409, 'KEY_VERSION_STALE', 'The room key changed; fetch the new key and retry', { currentKeyVersion: couple.keyVersion });
  }
  const existing = await CanvasOp.findOne({ senderId: user._id, clientOpId: input.clientOpId });
  if (existing) return { op: opView(existing), created: false, canvasId: String(canvas._id) };

  // Atomic sequence allocation. A crash after this leaves a harmless gap; clients tolerate gaps.
  const bumped = await Canvas.findOneAndUpdate(
    { _id: canvas._id, archivedAt: null, opCount: { $lt: MAX_OPS } },
    { $inc: { seq: 1, opCount: 1 } },
    { new: true }
  );
  if (!bumped) throw new AppError(409, 'CANVAS_FULL', 'This canvas is full. Start a new one.');
  try {
    const doc = await CanvasOp.create({
      coupleId: couple._id, canvasId: canvas._id, seq: bumped.seq, clientOpId: input.clientOpId,
      senderId: user._id, senderDeviceId: device._id, keyVersion: input.keyVersion, nonce: input.nonce, ciphertext: input.ciphertext,
    });
    return { op: opView(doc), created: true, canvasId: String(canvas._id) };
  } catch (e) {
    if (e.code === 11000) {
      const dup = await CanvasOp.findOne({ senderId: user._id, clientOpId: input.clientOpId });
      if (dup) return { op: opView(dup), created: false, canvasId: String(canvas._id) };
    }
    throw e;
  }
}

async function setFavorite(user, canvasId, favorite) {
  const { canvas } = await getCanvasForUser(user, canvasId);
  await Canvas.updateOne({ _id: canvas._id }, favorite ? { $addToSet: { favoritedBy: user._id } } : { $pull: { favoritedBy: user._id } });
  return canvasView(await Canvas.findById(canvas._id), user);
}

// Archived for both partners. Ciphertext is purged by the retention job (Phase 6).
async function archiveCanvas(user, canvasId) {
  const { canvas } = await getCanvasForUser(user, canvasId);
  await Canvas.updateOne({ _id: canvas._id }, { $set: { archivedAt: new Date() } });
  return String(canvas._id);
}

module.exports = { getCanvasForUser, createCanvas, listCanvases, listOps, appendOp, setFavorite, archiveCanvas, MAX_OPS };
