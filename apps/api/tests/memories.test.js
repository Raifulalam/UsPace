const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const MediaAsset = require('../src/models/MediaAsset');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const rnd = (n) => crypto.randomBytes(n).toString('base64');
const uuid = () => crypto.randomUUID();
const mem = (over = {}) => ({ clientMemoryId: uuid(), type: 'note', eventDate: '2024-05-01', keyVersion: 1, nonce: rnd(24), ciphertext: rnd(80), ...over });
const album = (over = {}) => ({ clientAlbumId: uuid(), keyVersion: 1, nonce: rnd(24), ciphertext: rnd(40), ...over });

async function upload(U, user, n = 120) {
  const asset = (await U.post('/api/v1/media', { kind: 'image', sizeBytes: n })).body.data.asset;
  await request(app).put(`/api/v1/media/${asset.id}/blob`).set('Authorization', `Bearer ${user.token}`).set('Content-Type', 'application/octet-stream').send(crypto.randomBytes(n));
  return asset;
}

test('create is idempotent, lists newest event first, and paginates with a cursor', async () => {
  const { A, B } = await makeCouple(app);
  const first = mem({ eventDate: '2024-01-01' });
  expect((await A.post('/api/v1/memories', first)).status).toBe(201);
  expect((await A.post('/api/v1/memories', first)).status).toBe(200); // same clientMemoryId
  for (const d of ['2024-03-01', '2024-02-01', '2024-03-01', '2023-12-25']) await B.post('/api/v1/memories', mem({ eventDate: d }));
  const p1 = await A.get('/api/v1/memories?limit=2');
  expect(p1.body.data.memories.map((m) => m.eventDate.slice(0, 10))).toEqual(['2024-03-01', '2024-03-01']);
  const p2 = await A.get(`/api/v1/memories?limit=2&before=${p1.body.data.nextCursor}`);
  expect(p2.body.data.memories.map((m) => m.eventDate.slice(0, 10))).toEqual(['2024-02-01', '2024-01-01']);
  const p3 = await A.get(`/api/v1/memories?limit=2&before=${p2.body.data.nextCursor}`);
  expect(p3.body.data.memories.map((m) => m.eventDate.slice(0, 10))).toEqual(['2023-12-25']);
  expect(p3.body.data.nextCursor).toBeNull();
  expect((await A.get('/api/v1/memories?before=garbage')).status).toBe(400);
});

test('type filter, per-user favorites and server-visible fields only', async () => {
  const { A, B } = await makeCouple(app);
  const note = (await A.post('/api/v1/memories', mem({ type: 'note' }))).body.data.memory;
  await A.post('/api/v1/memories', mem({ type: 'letter' }));
  expect((await A.get('/api/v1/memories?type=letter')).body.data.memories).toHaveLength(1);
  expect((await A.put(`/api/v1/memories/${note.id}/favorite`, { favorite: true })).body.data.memory.favorite).toBe(true);
  expect((await A.get('/api/v1/memories?favorite=true')).body.data.memories.map((m) => m.id)).toEqual([note.id]);
  expect((await B.get('/api/v1/memories?favorite=true')).body.data.memories).toHaveLength(0); // favorites are personal
  expect(Object.keys(note).sort()).toEqual(['albumId', 'canvasId', 'ciphertext', 'clientMemoryId', 'createdAt', 'createdBy', 'downloadLocked', 'eventDate', 'favorite', 'id', 'keyVersion', 'mediaIds', 'nonce', 'type', 'updatedAt']);
});

test('validation, stale keys and references to things that are not yours', async () => {
  const one = await makeCouple(app);
  const two = await makeCouple(app);
  const theirs = await upload(two.A, two.a);
  const theirAlbum = (await two.A.post('/api/v1/memories/albums', album())).body.data.album;
  const theirCanvas = (await two.A.post('/api/v1/canvases')).body.data.canvas;
  expect((await one.A.post('/api/v1/memories', mem({ keyVersion: 9 }))).status).toBe(409);
  expect((await one.A.post('/api/v1/memories', mem({ type: 'hacked' }))).status).toBe(400);
  expect((await one.A.post('/api/v1/memories', mem({ eventDate: '2024-13-45' }))).status).toBe(400);
  expect((await one.A.post('/api/v1/memories', { ...mem(), title: 'plaintext!' })).status).toBe(400);
  expect((await one.A.post('/api/v1/memories', mem({ mediaIds: [theirs.id] }))).status).toBe(400);
  expect((await one.A.post('/api/v1/memories', mem({ albumId: theirAlbum.id }))).status).toBe(400);
  expect((await one.A.post('/api/v1/memories', mem({ canvasId: theirCanvas.id }))).status).toBe(400);
});

test('couples cannot see or change each other\'s memories; outsiders get nothing', async () => {
  const one = await makeCouple(app);
  const two = await makeCouple(app);
  const outsider = authed(app, await registerUser(app));
  const m = (await one.A.post('/api/v1/memories', mem())).body.data.memory;
  expect((await two.A.get('/api/v1/memories')).body.data.memories).toHaveLength(0);
  expect((await two.A.patch(`/api/v1/memories/${m.id}`, { downloadLocked: true })).status).toBe(404);
  expect((await two.A.put(`/api/v1/memories/${m.id}/favorite`, { favorite: true })).status).toBe(404);
  expect((await two.A.del(`/api/v1/memories/${m.id}`)).status).toBe(404);
  expect((await outsider.get('/api/v1/memories')).status).toBe(404);
  expect((await outsider.post('/api/v1/memories', mem())).status).toBe(404);
});

test('editing: re-encrypt needs the full triple and the current key; album filing; media swap frees the old file', async () => {
  const { a, A } = await makeCouple(app);
  const alb = (await A.post('/api/v1/memories/albums', album())).body.data.album;
  const f1 = await upload(A, a);
  const f2 = await upload(A, a);
  const m = (await A.post('/api/v1/memories', mem({ type: 'photo', mediaIds: [f1.id] }))).body.data.memory;
  expect((await A.patch(`/api/v1/memories/${m.id}`, { nonce: rnd(24) })).status).toBe(400);
  expect((await A.patch(`/api/v1/memories/${m.id}`, { mediaIds: [f2.id] })).status).toBe(400); // media change needs new ciphertext
  expect((await A.patch(`/api/v1/memories/${m.id}`, { keyVersion: 7, nonce: rnd(24), ciphertext: rnd(80) })).status).toBe(409);
  const edited = await A.patch(`/api/v1/memories/${m.id}`, { eventDate: '2024-06-06', albumId: alb.id, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(90), mediaIds: [f2.id] });
  expect(edited.status).toBe(200);
  expect(edited.body.data.memory.albumId).toBe(alb.id);
  expect((await MediaAsset.findById(f1.id)).status).toBe('deleted');
  expect((await MediaAsset.findById(f2.id)).status).toBe('ready');
  expect((await A.get(`/api/v1/memories?albumId=${alb.id}`)).body.data.memories).toHaveLength(1);
  expect((await A.patch(`/api/v1/memories/${m.id}`, { albumId: null })).body.data.memory.albumId).toBeNull();
});

test('deleting a memory hides it, frees its files, and either partner may do it', async () => {
  const { a, A, B } = await makeCouple(app);
  const f = await upload(A, a);
  const m = (await A.post('/api/v1/memories', mem({ type: 'photo', mediaIds: [f.id] }))).body.data.memory;
  expect((await B.del(`/api/v1/memories/${m.id}`)).status).toBe(204);
  expect((await A.get('/api/v1/memories')).body.data.memories).toHaveLength(0);
  expect((await MediaAsset.findById(f.id)).status).toBe('deleted');
  expect((await A.del(`/api/v1/memories/${m.id}`)).status).toBe(404);
});

test('albums: create, list, rename, delete (memories are kept, just unfiled)', async () => {
  const { A, B } = await makeCouple(app);
  const a1 = album();
  const created = await A.post('/api/v1/memories/albums', a1);
  expect(created.status).toBe(201);
  expect((await B.post('/api/v1/memories/albums', a1)).status).toBe(201); // different creator, different idempotency key
  expect((await A.post('/api/v1/memories/albums', { ...a1, keyVersion: 5 })).status).toBe(409);
  expect((await B.get('/api/v1/memories/albums')).body.data.albums.length).toBe(2);
  const renamed = await B.patch(`/api/v1/memories/albums/${created.body.data.album.id}`, { keyVersion: 1, nonce: rnd(24), ciphertext: rnd(50) });
  expect(renamed.status).toBe(200);
  const m = (await A.post('/api/v1/memories', mem({ albumId: created.body.data.album.id }))).body.data.memory;
  expect((await A.del(`/api/v1/memories/albums/${created.body.data.album.id}`)).status).toBe(204);
  expect((await A.get('/api/v1/memories')).body.data.memories.find((x) => x.id === m.id).albumId).toBeNull();
  expect((await A.del(`/api/v1/memories/albums/${created.body.data.album.id}`)).status).toBe(404);
});
