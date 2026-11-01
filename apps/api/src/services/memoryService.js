const { encodeCursor, decodeCursor } = require('@couples/media-core');
const Memory = require('../models/Memory');
const Album = require('../models/Album');
const Canvas = require('../models/Canvas');
const AppError = require('../utils/AppError');
const { requireActiveCouple } = require('./access');
const media = require('./mediaService');

const memoryView = (m, user) => ({
  id: m.id, createdBy: String(m.createdBy), clientMemoryId: m.clientMemoryId, type: m.type, eventDate: m.eventDate,
  albumId: m.albumId ? String(m.albumId) : null, mediaIds: (m.mediaIds || []).map(String), canvasId: m.canvasId ? String(m.canvasId) : null,
  favorite: m.favoritedBy.some((u) => String(u) === String(user._id)), downloadLocked: m.downloadLocked,
  keyVersion: m.keyVersion, nonce: m.nonce, ciphertext: m.ciphertext, createdAt: m.createdAt, updatedAt: m.updatedAt,
});
const albumView = (a) => ({ id: a.id, createdBy: String(a.createdBy), clientAlbumId: a.clientAlbumId, keyVersion: a.keyVersion, nonce: a.nonce, ciphertext: a.ciphertext, createdAt: a.createdAt });

function assertCurrentKey(couple, keyVersion) {
  if (keyVersion !== couple.keyVersion) throw new AppError(409, 'KEY_VERSION_STALE', 'The room key changed; fetch the new key and retry', { currentKeyVersion: couple.keyVersion });
}
const toDate = (s) => new Date(`${s}T00:00:00Z`);

// Everything referenced must belong to THIS couple. Another couple's ids are indistinguishable from nonexistent ones.
async function assertAlbum(coupleId, albumId) {
  if (!(await Album.exists({ _id: albumId, coupleId, deletedAt: null }))) throw new AppError(400, 'BAD_ALBUM', 'No such album');
}
async function assertCanvas(coupleId, canvasId) {
  if (!(await Canvas.exists({ _id: canvasId, coupleId }))) throw new AppError(400, 'BAD_CANVAS', 'No such canvas');
}
async function findMine(couple, id) {
  const m = await Memory.findOne({ _id: id, coupleId: couple._id, deletedAt: null });
  if (!m) throw new AppError(404, 'MEMORY_NOT_FOUND', 'No such memory');
  return m;
}

async function createMemory(user, input) {
  const couple = await requireActiveCouple(user);
  assertCurrentKey(couple, input.keyVersion);
  if (input.albumId) await assertAlbum(couple._id, input.albumId);
  if (input.canvasId) await assertCanvas(couple._id, input.canvasId);
  if (input.mediaIds?.length) await media.assertAttachable(couple._id, input.mediaIds);
  try {
    const m = await Memory.create({
      coupleId: couple._id, createdBy: user._id, clientMemoryId: input.clientMemoryId, type: input.type, eventDate: toDate(input.eventDate),
      albumId: input.albumId, mediaIds: input.mediaIds || [], canvasId: input.canvasId, downloadLocked: input.downloadLocked || false,
      keyVersion: input.keyVersion, nonce: input.nonce, ciphertext: input.ciphertext,
    });
    return { memory: memoryView(m, user), created: true, coupleId: String(couple._id) };
  } catch (e) {
    if (e.code === 11000) {
      const existing = await Memory.findOne({ createdBy: user._id, clientMemoryId: input.clientMemoryId, coupleId: couple._id });
      if (existing) return { memory: memoryView(existing, user), created: false, coupleId: String(couple._id) };
    }
    throw e;
  }
}

async function listMemories(user, { type, favorite, albumId, before, limit }) {
  const couple = await requireActiveCouple(user);
  const q = { coupleId: couple._id, deletedAt: null };
  if (type) q.type = type;
  if (albumId) q.albumId = albumId;
  if (favorite) q.favoritedBy = user._id;
  if (before) {
    const c = decodeCursor(before);
    if (!c) throw new AppError(400, 'BAD_CURSOR', 'Invalid cursor');
    q.$or = [{ eventDate: { $lt: new Date(c.ms) } }, { eventDate: new Date(c.ms), _id: { $lt: c.id } }];
  }
  const rows = await Memory.find(q).sort({ eventDate: -1, _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { memories: page.map((m) => memoryView(m, user)), nextCursor: rows.length > limit ? encodeCursor(last.eventDate.getTime(), last.id) : null };
}

async function updateMemory(user, id, patch) {
  const couple = await requireActiveCouple(user);
  const m = await findMine(couple, id);
  const set = {};
  const unset = {};
  if (patch.eventDate) set.eventDate = toDate(patch.eventDate);
  if (patch.downloadLocked !== undefined) set.downloadLocked = patch.downloadLocked;
  if (patch.albumId === null) unset.albumId = 1;
  else if (patch.albumId) { await assertAlbum(couple._id, patch.albumId); set.albumId = patch.albumId; }
  if (patch.ciphertext) {
    assertCurrentKey(couple, patch.keyVersion);
    Object.assign(set, { keyVersion: patch.keyVersion, nonce: patch.nonce, ciphertext: patch.ciphertext });
  }
  let removed = [];
  if (patch.mediaIds) {
    const keep = new Set(patch.mediaIds);
    const added = patch.mediaIds.filter((x) => !m.mediaIds.map(String).includes(x));
    if (added.length) await media.assertAttachable(couple._id, added);
    removed = m.mediaIds.map(String).filter((x) => !keep.has(x));
    set.mediaIds = patch.mediaIds;
  }
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  const updated = await Memory.findOneAndUpdate({ _id: m._id, deletedAt: null }, update, { new: true });
  if (!updated) throw new AppError(404, 'MEMORY_NOT_FOUND', 'No such memory');
  if (removed.length) await media.releaseIfUnreferenced(couple._id, removed);
  return { memory: memoryView(updated, user), coupleId: String(couple._id) };
}

async function setFavorite(user, id, favorite) {
  const couple = await requireActiveCouple(user);
  const m = await Memory.findOneAndUpdate(
    { _id: id, coupleId: couple._id, deletedAt: null },
    favorite ? { $addToSet: { favoritedBy: user._id } } : { $pull: { favoritedBy: user._id } },
    { new: true }
  );
  if (!m) throw new AppError(404, 'MEMORY_NOT_FOUND', 'No such memory');
  return memoryView(m, user);
}

// Either partner may delete: the memories belong to the couple. Files nothing else uses are removed and quota refunded.
async function deleteMemory(user, id) {
  const couple = await requireActiveCouple(user);
  const m = await Memory.findOneAndUpdate({ _id: id, coupleId: couple._id, deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true });
  if (!m) throw new AppError(404, 'MEMORY_NOT_FOUND', 'No such memory');
  await media.releaseIfUnreferenced(couple._id, m.mediaIds);
  return String(couple._id);
}

// ---------- albums ----------
async function createAlbum(user, input) {
  const couple = await requireActiveCouple(user);
  assertCurrentKey(couple, input.keyVersion);
  if ((await Album.countDocuments({ coupleId: couple._id, deletedAt: null })) >= 100) throw new AppError(409, 'TOO_MANY_ALBUMS', 'Delete an album first');
  try {
    return albumView(await Album.create({ coupleId: couple._id, createdBy: user._id, ...input }));
  } catch (e) {
    if (e.code === 11000) { const ex = await Album.findOne({ createdBy: user._id, clientAlbumId: input.clientAlbumId, coupleId: couple._id }); if (ex) return albumView(ex); }
    throw e;
  }
}
async function listAlbums(user) {
  const couple = await requireActiveCouple(user);
  return (await Album.find({ coupleId: couple._id, deletedAt: null }).sort({ createdAt: 1 })).map(albumView);
}
async function renameAlbum(user, id, input) {
  const couple = await requireActiveCouple(user);
  assertCurrentKey(couple, input.keyVersion);
  const a = await Album.findOneAndUpdate({ _id: id, coupleId: couple._id, deletedAt: null }, { $set: input }, { new: true });
  if (!a) throw new AppError(404, 'ALBUM_NOT_FOUND', 'No such album');
  return albumView(a);
}
async function deleteAlbum(user, id) {
  const couple = await requireActiveCouple(user);
  const a = await Album.findOneAndUpdate({ _id: id, coupleId: couple._id, deletedAt: null }, { $set: { deletedAt: new Date() } });
  if (!a) throw new AppError(404, 'ALBUM_NOT_FOUND', 'No such album');
  await Memory.updateMany({ coupleId: couple._id, albumId: a._id }, { $unset: { albumId: 1 } }); // memories are kept, just unfiled
}

module.exports = { createMemory, listMemories, updateMemory, setFavorite, deleteMemory, createAlbum, listAlbums, renameAlbum, deleteAlbum };
