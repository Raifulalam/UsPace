const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const retention = require('../src/services/retentionService');
const { getStorage } = require('../src/storage');
const User = require('../src/models/User');
const Couple = require('../src/models/Couple');
const Device = require('../src/models/Device');
const Message = require('../src/models/Message');
const Canvas = require('../src/models/Canvas');
const CanvasOp = require('../src/models/CanvasOp');
const Memory = require('../src/models/Memory');
const Album = require('../src/models/Album');
const MediaAsset = require('../src/models/MediaAsset');
const RoomKeyEnvelope = require('../src/models/RoomKeyEnvelope');
const RecoveryBlob = require('../src/models/RecoveryBlob');
const RefreshToken = require('../src/models/RefreshToken');
const Report = require('../src/models/Report');
const { startDb, stopDb, makeCouple, PASSWORD } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const DAY = 86400000;
const rnd = (n) => crypto.randomBytes(n).toString('base64');
const oid = (id) => new mongoose.Types.ObjectId(id);

// Fills a couple's room with every kind of content the retention job must erase.
async function seed(c) {
  c.coupleId = (await c.A.get('/api/v1/couples/me')).body.data.couple.id;
  c.da = (await c.A.post('/api/v1/devices', { publicKey: rnd(32), label: 'dev' })).body.data.device.id;
  await c.A.put('/api/v1/keys/envelopes', { senderDeviceId: c.da, envelopes: [{ keyVersion: 1, deviceId: c.da, nonce: rnd(24), ciphertext: rnd(48) }] });
  await c.A.post('/api/v1/messages', { clientMsgId: crypto.randomUUID(), deviceId: c.da, keyVersion: 1, kind: 'text', nonce: rnd(24), ciphertext: rnd(64) });
  const canvas = (await c.A.post('/api/v1/canvases')).body.data.canvas;
  await c.A.post(`/api/v1/canvases/${canvas.id}/ops`, { clientOpId: crypto.randomUUID(), deviceId: c.da, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(100) });
  const asset = (await c.A.post('/api/v1/media', { kind: 'image', sizeBytes: 100 })).body.data.asset;
  await request(app).put(`/api/v1/media/${asset.id}/blob`).set('Authorization', `Bearer ${c.a.token}`).set('Content-Type', 'application/octet-stream').send(crypto.randomBytes(100));
  await c.A.post('/api/v1/memories/albums', { clientAlbumId: crypto.randomUUID(), keyVersion: 1, nonce: rnd(24), ciphertext: rnd(40) });
  await c.A.post('/api/v1/memories', { clientMemoryId: crypto.randomUUID(), type: 'photo', eventDate: '2024-05-01', keyVersion: 1, nonce: rnd(24), ciphertext: rnd(80), mediaIds: [asset.id] });
  c.storageKey = (await MediaAsset.findById(asset.id)).storageKey;
  return c;
}
const contentCounts = async (coupleId) => {
  const q = { coupleId };
  return {
    messages: await Message.countDocuments(q), ops: await CanvasOp.countDocuments(q), canvases: await Canvas.countDocuments(q),
    memories: await Memory.countDocuments(q), albums: await Album.countDocuments(q), files: await MediaAsset.countDocuments(q),
    envelopes: await RoomKeyEnvelope.countDocuments(q), couple: await Couple.countDocuments({ _id: coupleId }),
  };
};

test('a closed room is kept for 30 days, then everything in it is permanently erased', async () => {
  const c = await seed(await makeCouple(app));
  const before = await contentCounts(c.coupleId);
  expect(Object.values(before).every((n) => n >= 1)).toBe(true);
  expect(await getStorage().exists(c.storageKey)).toBe(true);

  await c.A.post('/api/v1/couples/me/leave');
  await retention.sweep();
  expect(await contentCounts(c.coupleId)).toEqual(before); // closed just now: nothing is deleted yet

  await Couple.collection.updateOne({ _id: oid(c.coupleId) }, { $set: { closedAt: new Date(Date.now() - 31 * DAY) } });
  const res = await retention.sweep();
  expect(res.couples).toBeGreaterThanOrEqual(1);
  expect(await contentCounts(c.coupleId)).toEqual({ messages: 0, ops: 0, canvases: 0, memories: 0, albums: 0, files: 0, envelopes: 0, couple: 0 });
  expect(await getStorage().exists(c.storageKey)).toBe(false); // the stored bytes are gone too
  expect((await User.findById(c.a.user.id)).status).toBe('active'); // people are not deleted, only the room
});

test('an active room is never purged, and other rooms are untouched', async () => {
  const live = await seed(await makeCouple(app));
  const dead = await seed(await makeCouple(app));
  const liveBefore = await contentCounts(live.coupleId);
  await Couple.collection.updateOne({ _id: oid(live.coupleId) }, { $set: { createdAt: new Date(Date.now() - 400 * DAY) } });
  await dead.A.post('/api/v1/couples/me/leave');
  await Couple.collection.updateOne({ _id: oid(dead.coupleId) }, { $set: { closedAt: new Date(Date.now() - 40 * DAY) } });
  await retention.sweep();
  expect(await contentCounts(live.coupleId)).toEqual(liveBefore);
  expect((await contentCounts(dead.coupleId)).couple).toBe(0);
  expect(await getStorage().exists(live.storageKey)).toBe(true);
});

test('a deleted account is erased after the grace period; abuse reports are kept; live accounts are never touched', async () => {
  const c = await makeCouple(app);
  c.da = (await c.A.post('/api/v1/devices', { publicKey: rnd(32), label: 'dev' })).body.data.device.id;
  await c.A.put('/api/v1/keys/recovery', { version: 1, nonce: rnd(24), ciphertext: rnd(300) });
  await c.A.post('/api/v1/safety/reports', { category: 'other', target: 'partner', details: 'for the record' });
  const id = c.a.user.id;

  expect(await retention.purgeUser(await User.findById(id))).toBe(false); // a live account is refused outright
  expect(await Device.countDocuments({ userId: id })).toBe(1);

  expect((await c.A.post('/api/v1/users/me/deletion', { password: PASSWORD })).status).toBe(200);
  await retention.sweep();
  expect(await User.countDocuments({ _id: id })).toBe(1); // still inside the 14-day grace period

  await User.updateOne({ _id: id }, { deletionScheduledAt: new Date(Date.now() - 1000) });
  const res = await retention.sweep();
  expect(res.users).toBeGreaterThanOrEqual(1);
  expect(await User.countDocuments({ _id: id })).toBe(0);
  expect(await Device.countDocuments({ userId: id })).toBe(0);
  expect(await RecoveryBlob.countDocuments({ userId: id })).toBe(0);
  expect(await RefreshToken.countDocuments({ userId: id })).toBe(0);
  expect(await Report.countDocuments({ reporterId: id })).toBe(1);
  expect(await User.countDocuments({ _id: c.b.user.id, status: 'active' })).toBe(1); // the partner is unaffected
});
