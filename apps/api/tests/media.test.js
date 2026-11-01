const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { createApp } = require('../src/app');
const Couple = require('../src/models/Couple');
const MediaAsset = require('../src/models/MediaAsset');
const media = require('../src/services/mediaService');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const rnd = (n) => crypto.randomBytes(n).toString('base64');
const bytes = (n) => crypto.randomBytes(n);
const addDevice = async (U) => (await U.post('/api/v1/devices', { publicKey: rnd(32), label: 'dev' })).body.data.device.id;

async function setup() {
  const c = await makeCouple(app);
  c.da = await addDevice(c.A);
  c.db = await addDevice(c.B);
  c.coupleId = (await c.A.get('/api/v1/couples/me')).body.data.couple.id;
  return c;
}
const put = (u, id, body, type = 'application/octet-stream') =>
  request(app).put(`/api/v1/media/${id}/blob`).set('Authorization', `Bearer ${u.token}`).set('Content-Type', type).send(body);
const get = (u, id) => request(app).get(`/api/v1/media/${id}/blob`).set('Authorization', `Bearer ${u.token}`).buffer(true).parse((res, cb) => { const d = []; res.on('data', (x) => d.push(x)); res.on('end', () => cb(null, Buffer.concat(d))); });
async function upload(U, user, kind = 'image', n = 120) {
  const asset = (await U.post('/api/v1/media', { kind, sizeBytes: n })).body.data.asset;
  const data = bytes(n);
  const res = await put(user, asset.id, data);
  return { asset, data, res };
}
const message = (deviceId, mediaIds, over = {}) => ({ clientMsgId: crypto.randomUUID(), deviceId, keyVersion: 1, kind: 'media', nonce: rnd(24), ciphertext: rnd(64), mediaIds, ...over });
const used = async (coupleId) => (await Couple.findById(coupleId)).storageUsed;

test('upload, download by the partner, exact bytes, safe headers', async () => {
  const { a, b, A, coupleId } = await setup();
  const { asset, data, res } = await upload(A, a);
  expect(res.status).toBe(200);
  expect(res.body.data.asset.status).toBe('ready');
  const dl = await get(b, asset.id);
  expect(dl.status).toBe(200);
  expect(Buffer.compare(dl.body, data)).toBe(0);
  expect(dl.headers['content-type']).toMatch(/^application\/octet-stream/);
  expect(dl.headers['x-content-type-options']).toBe('nosniff');
  expect(dl.headers['content-disposition']).toMatch(/attachment/);
  expect(await used(coupleId)).toBe(120);
});

test('other couples and outsiders can neither download nor upload', async () => {
  const one = await setup();
  const two = await setup();
  const outsider = await registerUser(app);
  const { asset } = await upload(one.A, one.a);
  expect((await get(two.a, asset.id)).status).toBe(404);
  expect((await get(outsider, asset.id)).status).toBe(404);
  const mine = (await one.A.post('/api/v1/media', { kind: 'image', sizeBytes: 100 })).body.data.asset;
  expect((await put(one.b, mine.id, bytes(100))).status).toBe(404); // partner is not the uploader
  expect((await put(two.a, mine.id, bytes(100))).status).toBe(404);
});

test('a pending (unfinished) file cannot be downloaded; wrong size is rejected and retry works', async () => {
  const { a, b, A } = await setup();
  const asset = (await A.post('/api/v1/media', { kind: 'image', sizeBytes: 100 })).body.data.asset;
  expect((await get(b, asset.id)).status).toBe(404);
  expect((await put(a, asset.id, bytes(99))).status).toBe(400);
  expect((await put(a, asset.id, bytes(101))).status).toBe(400);
  expect((await put(a, asset.id, bytes(100), 'image/png')).status).toBe(415);
  expect((await put(a, asset.id, bytes(100))).status).toBe(200); // still pending after the failures, so retry succeeds
  expect((await put(a, asset.id, bytes(100))).status).toBe(409); // but only once
});

test('creation validates size and kind', async () => {
  const { A } = await setup();
  expect((await A.post('/api/v1/media', { kind: 'image', sizeBytes: 10 })).status).toBe(400); // smaller than an encrypted file can be
  expect((await A.post('/api/v1/media', { kind: 'thumb', sizeBytes: 600 * 1024 })).status).toBe(400);
  expect((await A.post('/api/v1/media', { kind: 'exe', sizeBytes: 100 })).status).toBe(400);
  expect((await A.post('/api/v1/media', { kind: 'image', sizeBytes: 100, extra: 1 })).status).toBe(400);
});

test('quota is enforced atomically and refunded when a file is deleted', async () => {
  const { a, A, coupleId } = await setup();
  await Couple.updateOne({ _id: coupleId }, { storageQuotaBytes: 250 });
  const first = await upload(A, a, 'image', 120);
  const second = await upload(A, a, 'image', 120);
  expect(second.res.status).toBe(200);
  const third = await A.post('/api/v1/media', { kind: 'image', sizeBytes: 120 });
  expect(third.status).toBe(413);
  expect(third.body.error.code).toBe('QUOTA_EXCEEDED');
  expect((await A.get('/api/v1/media/usage')).body.data).toEqual({ used: 240, quota: 250 });
  expect((await A.del(`/api/v1/media/${first.asset.id}`)).status).toBe(204);
  expect(await used(coupleId)).toBe(120);
  expect((await A.post('/api/v1/media', { kind: 'image', sizeBytes: 120 })).status).toBe(201);
});

test('attachments: must be ready and from your room; deleting the message frees the file', async () => {
  const { a, b, A, B, da, coupleId } = await setup();
  const other = await setup();
  const pending = (await A.post('/api/v1/media', { kind: 'image', sizeBytes: 100 })).body.data.asset;
  expect((await A.post('/api/v1/messages', message(da, [pending.id]))).status).toBe(400);
  const foreign = await upload(other.A, other.a);
  expect((await A.post('/api/v1/messages', message(da, [foreign.asset.id]))).status).toBe(400);
  expect((await A.post('/api/v1/messages', message(da, ['not-an-id']))).status).toBe(400);

  const { asset } = await upload(A, a);
  const sent = await A.post('/api/v1/messages', message(da, [asset.id]));
  expect(sent.status).toBe(201);
  expect(sent.body.data.message.mediaIds).toEqual([asset.id]);
  expect((await A.del(`/api/v1/media/${asset.id}`)).status).toBe(409); // still in use
  expect((await B.del(`/api/v1/messages/${sent.body.data.message.id}`)).status).toBe(404); // only the sender can delete
  expect((await A.del(`/api/v1/messages/${sent.body.data.message.id}`)).status).toBe(204);
  expect((await MediaAsset.findById(asset.id)).status).toBe('deleted');
  expect((await get(b, asset.id)).status).toBe(404);
  expect(await used(coupleId)).toBe(100); // only the 'pending' reservation remains
});

test('a file shared with a memory survives deleting the message that also used it', async () => {
  const { a, A, da } = await setup();
  const { asset } = await upload(A, a);
  const sent = (await A.post('/api/v1/messages', message(da, [asset.id]))).body.data.message;
  const mem = await A.post('/api/v1/memories', { clientMemoryId: crypto.randomUUID(), type: 'photo', eventDate: '2024-05-01', keyVersion: 1, nonce: rnd(24), ciphertext: rnd(80), mediaIds: [asset.id] });
  expect(mem.status).toBe(201);
  await A.del(`/api/v1/messages/${sent.id}`);
  expect((await MediaAsset.findById(asset.id)).status).toBe('ready');
  await A.del(`/api/v1/memories/${mem.body.data.memory.id}`);
  expect((await MediaAsset.findById(asset.id)).status).toBe('deleted');
});

test('sweep releases abandoned uploads and unreferenced files, and keeps referenced ones', async () => {
  const { a, A, da, coupleId } = await setup();
  const abandoned = (await A.post('/api/v1/media', { kind: 'image', sizeBytes: 100 })).body.data.asset;
  const orphan = await upload(A, a);
  const kept = await upload(A, a);
  await A.post('/api/v1/messages', message(da, [kept.asset.id]));
  const hours = (n) => new Date(Date.now() - n * 3600 * 1000);
  // Write through the raw collection: Mongoose treats createdAt as immutable and would silently ignore the change.
  const oid = (id) => new mongoose.Types.ObjectId(id);
  await MediaAsset.collection.updateOne({ _id: oid(abandoned.id) }, { $set: { createdAt: hours(2) } });
  await MediaAsset.collection.updateOne({ _id: oid(orphan.asset.id) }, { $set: { readyAt: hours(25) } });
  await MediaAsset.collection.updateOne({ _id: oid(kept.asset.id) }, { $set: { readyAt: hours(25) } });
  expect(await media.sweep()).toEqual({ pending: 1, orphans: 1 });
  expect((await MediaAsset.findById(abandoned.id)).status).toBe('deleted');
  expect((await MediaAsset.findById(orphan.asset.id)).status).toBe('deleted');
  expect((await MediaAsset.findById(kept.asset.id)).status).toBe('ready');
  expect(await used(coupleId)).toBe(120);
  expect(await media.sweep()).toEqual({ pending: 0, orphans: 0 }); // idempotent
});
