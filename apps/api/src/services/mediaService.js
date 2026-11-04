const mongoose = require('mongoose');
const config = require('../config/env');
const { LIMITS, encryptedSize } = require('@couples/media-core');
const Couple = require('../models/Couple');
const MediaAsset = require('../models/MediaAsset');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const AppError = require('../utils/AppError');
const { getStorage } = require('../storage');
const { requireActiveCouple } = require('./access');
const settings = require('./settingsService');

const MAX_PENDING = 20;
const PENDING_TTL_MS = 60 * 60 * 1000; // an unfinished upload is released after 1 hour
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000; // an uploaded file nothing references is released after 24 hours
const MIN_SIZE = encryptedSize(0);

const view = (a) => ({ id: a.id, kind: a.kind, sizeBytes: a.sizeBytes, status: a.status });

/** Reserve space for one encrypted file. The exact ciphertext size is declared up front and enforced on upload. */
async function createAsset(user, { kind, sizeBytes }) {
  const couple = await requireActiveCouple(user);
  if (sizeBytes < MIN_SIZE || sizeBytes > encryptedSize(LIMITS[kind])) throw new AppError(400, 'BAD_SIZE', 'File size is outside the allowed range');
  if ((await MediaAsset.countDocuments({ coupleId: couple._id, status: { $in: ['pending', 'uploading'] } })) >= MAX_PENDING) {
    throw new AppError(429, 'TOO_MANY_UPLOADS', 'Too many uploads in progress');
  }
  const freeBytes = (await settings.get()).limits.freeStorageBytes;
  // Atomic: reserve only if it still fits. Two simultaneous uploads cannot both squeeze past the quota.
  const reserved = await Couple.findOneAndUpdate(
    { _id: couple._id, $expr: { $lte: [{ $add: ['$storageUsed', sizeBytes] }, { $ifNull: ['$storageQuotaBytes', freeBytes] }] } },
    { $inc: { storageUsed: sizeBytes } }
  );
  if (!reserved) throw new AppError(413, 'QUOTA_EXCEEDED', 'Your shared storage is full');
  const _id = new mongoose.Types.ObjectId();
  try {
    const a = await MediaAsset.create({ _id, coupleId: couple._id, uploaderId: user._id, kind, sizeBytes, storageKey: `${couple.id}/${_id}` });
    return view(a);
  } catch (e) {
    await Couple.updateOne({ _id: couple._id }, { $inc: { storageUsed: -sizeBytes } });
    throw e;
  }
}

/** Stream the ciphertext to storage. Only the uploader, only once, only with exactly the reserved byte count. */
async function uploadBlob(user, id, req) {
  const couple = await requireActiveCouple(user);
  const asset = await MediaAsset.findOneAndUpdate(
    { _id: id, coupleId: couple._id, uploaderId: user._id, status: 'pending' },
    { $set: { status: 'uploading' } },
    { new: true }
  );
  if (!asset) {
    const exists = await MediaAsset.exists({ _id: id, coupleId: couple._id, uploaderId: user._id, status: { $in: ['uploading', 'ready'] } });
    throw exists ? new AppError(409, 'ALREADY_UPLOADED', 'This file was already uploaded') : new AppError(404, 'ASSET_NOT_FOUND', 'No such upload');
  }
  const back = () => MediaAsset.updateOne({ _id: asset._id, status: 'uploading' }, { $set: { status: 'pending' } }); // allow a retry
  if (!(req.headers['content-type'] || '').startsWith('application/octet-stream')) { await back(); throw new AppError(415, 'BAD_CONTENT_TYPE', 'Upload must be application/octet-stream'); }
  if (Number(req.headers['content-length']) !== asset.sizeBytes) { await back(); throw new AppError(400, 'SIZE_MISMATCH', 'Upload size does not match what was reserved'); }
  try {
    await getStorage().put(asset.storageKey, req, asset.sizeBytes);
  } catch (e) {
    await back();
    if (e.code === 'SIZE_EXCEEDED' || e.code === 'SIZE_MISMATCH') throw new AppError(400, 'SIZE_MISMATCH', 'Upload size does not match what was reserved');
    throw new AppError(499, 'UPLOAD_ABORTED', 'Upload interrupted');
  }
  const done = await MediaAsset.findOneAndUpdate({ _id: asset._id, status: 'uploading' }, { $set: { status: 'ready', readyAt: new Date() } }, { new: true });
  if (!done) { await getStorage().delete(asset.storageKey); throw new AppError(409, 'UPLOAD_CANCELLED', 'Upload was cancelled'); }
  return view(done);
}

/** Membership is checked in the query itself: another couple's asset id simply does not exist for you. */
async function openBlob(user, id) {
  const couple = await requireActiveCouple(user);
  const asset = await MediaAsset.findOne({ _id: id, coupleId: couple._id, status: 'ready' });
  if (!asset) throw new AppError(404, 'ASSET_NOT_FOUND', 'No such file');
  return { asset, stream: getStorage().createReadStream(asset.storageKey) };
}

async function isReferenced(coupleId, id) {
  return Boolean((await Message.exists({ coupleId, mediaIds: id, deletedAt: null })) || (await Memory.exists({ coupleId, mediaIds: id, deletedAt: null })));
}

/** Free the file and refund its quota. Safe to call twice: only the first caller flips the status. */
async function purgeAsset(asset) {
  const flipped = await MediaAsset.findOneAndUpdate({ _id: asset._id, status: { $ne: 'deleted' } }, { $set: { status: 'deleted', deletedAt: new Date() } });
  if (!flipped) return false;
  await getStorage().delete(asset.storageKey).catch(() => {});
  await Couple.updateOne({ _id: asset.coupleId }, { $inc: { storageUsed: -asset.sizeBytes } });
  return true;
}

/** Called after a message or memory stops referencing files. Files still used elsewhere are kept. */
async function releaseIfUnreferenced(coupleId, ids) {
  let freed = 0;
  for (const id of new Set((ids || []).map(String))) {
    if (await isReferenced(coupleId, id)) continue;
    const asset = await MediaAsset.findOne({ _id: id, coupleId });
    if (asset && (await purgeAsset(asset))) freed++;
  }
  return freed;
}

/** Every id must be a finished upload belonging to this couple. */
async function assertAttachable(coupleId, ids) {
  const unique = [...new Set(ids.map(String))];
  if (unique.length !== ids.length) throw new AppError(400, 'BAD_MEDIA', 'Duplicate media ids');
  const found = await MediaAsset.countDocuments({ _id: { $in: unique }, coupleId, status: 'ready' });
  if (found !== unique.length) throw new AppError(400, 'BAD_MEDIA', 'Every attached file must be a finished upload from your room');
}

async function deleteOwn(user, id) {
  const couple = await requireActiveCouple(user);
  const asset = await MediaAsset.findOne({ _id: id, coupleId: couple._id, uploaderId: user._id, status: { $ne: 'deleted' } });
  if (!asset) throw new AppError(404, 'ASSET_NOT_FOUND', 'No such file');
  if (await isReferenced(couple._id, asset._id)) throw new AppError(409, 'IN_USE', 'This file is still used by a message or memory');
  await purgeAsset(asset);
}

async function usage(user) {
  const couple = await requireActiveCouple(user);
  return { used: Math.max(0, couple.storageUsed || 0), quota: couple.storageQuotaBytes ?? (await settings.get()).limits.freeStorageBytes };
}

/** Housekeeping: abandoned uploads and files nothing references. Run on a timer and from tests. */
async function sweep(now = Date.now()) {
  let pending = 0, orphans = 0;
  const stale = await MediaAsset.find({ status: { $in: ['pending', 'uploading'] }, createdAt: { $lt: new Date(now - PENDING_TTL_MS) } }).limit(500);
  for (const a of stale) if (await purgeAsset(a)) pending++;
  const old = await MediaAsset.find({ status: 'ready', readyAt: { $lt: new Date(now - ORPHAN_TTL_MS) } }).limit(500);
  for (const a of old) if (!(await isReferenced(a.coupleId, a._id)) && (await purgeAsset(a))) orphans++;
  return { pending, orphans };
}

module.exports = { createAsset, uploadBlob, openBlob, deleteOwn, usage, releaseIfUnreferenced, assertAttachable, sweep, purgeAsset };
