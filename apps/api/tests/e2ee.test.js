const crypto = require('crypto');
const http = require('http');
const mongoose = require('mongoose');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachSockets } = require('../src/sockets');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
const rnd = (n) => crypto.randomBytes(n).toString('base64');
const uuid = () => crypto.randomUUID();
let server, io, port;
const clients = [];

beforeAll(async () => {
  await startDb();
  server = http.createServer(app);
  io = attachSockets(server);
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
afterAll(async () => {
  clients.forEach((c) => c.close());
  if (io) io.close();
  if (server && server.listening) await new Promise((r) => server.close(r));
  await stopDb();
});

const addDevice = async (U, label = 'phone') => (await U.post('/api/v1/devices', { publicKey: rnd(32), label })).body.data.device.id;
const msg = (deviceId, over = {}) => ({ clientMsgId: uuid(), deviceId, keyVersion: 1, kind: 'text', nonce: rnd(24), ciphertext: rnd(64), ...over });

async function setup() {
  const c = await makeCouple(app);
  c.da = await addDevice(c.A, 'A phone');
  c.db = await addDevice(c.B, 'B phone');
  const env = (deviceId) => ({ keyVersion: 1, deviceId, nonce: rnd(24), ciphertext: rnd(48) });
  const put = await c.A.put('/api/v1/keys/envelopes', { senderDeviceId: c.da, envelopes: [env(c.da), env(c.db)] });
  expect(put.status).toBe(200);
  return c;
}

describe('devices', () => {
  test('validates keys, rejects duplicates, lists only own devices', async () => {
    const U = authed(app, await registerUser(app));
    expect((await U.post('/api/v1/devices', { publicKey: 'short', label: 'x' })).status).toBe(400);
    const pk = rnd(32);
    expect((await U.post('/api/v1/devices', { publicKey: pk, label: 'laptop' })).status).toBe(201);
    expect((await U.post('/api/v1/devices', { publicKey: pk, label: 'again' })).status).toBe(409);
    const other = authed(app, await registerUser(app));
    expect((await other.get('/api/v1/devices')).body.data.devices).toHaveLength(0);
  });
});

describe('room key envelopes', () => {
  test('activation sets keyVersion 1; each device reads only its own envelopes', async () => {
    const { A, B, da, db } = await setup();
    expect((await A.get('/api/v1/couples/me')).body.data.couple.keyVersion).toBe(1);
    const mine = await B.get(`/api/v1/keys/envelopes?deviceId=${db}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.envelopes).toHaveLength(1);
    expect((await B.get(`/api/v1/keys/envelopes?deviceId=${da}`)).status).toBe(404); // partner's device
  });
  test('couple-devices reports which devices already hold the current key', async () => {
    const { A, da, db } = await setup();
    const fresh = await addDevice(A, 'new laptop');
    const r = await A.get('/api/v1/keys/couple-devices');
    const byId = Object.fromEntries(r.body.data.devices.map((d) => [d.id, d.hasKey]));
    expect(byId).toEqual({ [da]: true, [db]: true, [fresh]: false });
  });
  test('rejects foreign senders, outsiders, future versions and unknown recipients', async () => {
    const { A, da, db } = await setup();
    const env = (deviceId, keyVersion = 1) => ({ keyVersion, deviceId, nonce: rnd(24), ciphertext: rnd(48) });
    expect((await A.put('/api/v1/keys/envelopes', { senderDeviceId: db, envelopes: [env(da)] })).status).toBe(403);
    expect((await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [env(da, 5)] })).status).toBe(400);

    const outsider = authed(app, await registerUser(app));
    const od = await addDevice(outsider);
    expect((await outsider.put('/api/v1/keys/envelopes', { senderDeviceId: od, envelopes: [env(da)] })).status).toBe(404);
    expect((await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [env(od)] })).status).toBe(400);
    expect((await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [{ ...env(da), ciphertext: rnd(10) }] })).status).toBe(400);
  });
  test('an unapproved device cannot inject envelopes; a trusted one can approve it; rotation needs the previous key', async () => {
    const { A, B, da, db } = await setup();
    const rogue = await addDevice(B, 'rogue');
    const env = (deviceId, keyVersion = 1) => ({ keyVersion, deviceId, nonce: rnd(24), ciphertext: rnd(48) });
    const bad = await B.put('/api/v1/keys/envelopes', { senderDeviceId: rogue, envelopes: [env(rogue)] });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('NOT_TRUSTED');

    const ok = await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [env(rogue)] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.stored).toBe(1);

    // After a revocation the version bumps; only a holder of v1 can create v2 envelopes.
    const spare = await addDevice(B, 'spare');
    expect((await B.del(`/api/v1/devices/${spare}`)).body.data.keyVersion).toBe(2);
    const newcomer = await addDevice(B, 'newcomer');
    expect((await B.put('/api/v1/keys/envelopes', { senderDeviceId: newcomer, envelopes: [env(newcomer, 2)] })).status).toBe(403);
    expect((await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [env(da, 2), env(db, 2)] })).status).toBe(200);
  });
  test('existing envelopes are never overwritten', async () => {
    const { A, da } = await setup();
    const before = (await A.get(`/api/v1/keys/envelopes?deviceId=${da}`)).body.data.envelopes[0].ciphertext;
    const r = await A.put('/api/v1/keys/envelopes', { senderDeviceId: da, envelopes: [{ keyVersion: 1, deviceId: da, nonce: rnd(24), ciphertext: rnd(48) }] });
    expect(r.body.data.stored).toBe(0);
    expect((await A.get(`/api/v1/keys/envelopes?deviceId=${da}`)).body.data.envelopes[0].ciphertext).toBe(before);
  });
});

describe('encrypted messages', () => {
  test('send, idempotency, history pagination, no plaintext fields', async () => {
    const { A, B, da } = await setup();
    const m = msg(da);
    const first = await A.post('/api/v1/messages', m);
    expect(first.status).toBe(201);
    expect((await A.post('/api/v1/messages', m)).status).toBe(200); // same clientMsgId
    for (let i = 0; i < 4; i++) await A.post('/api/v1/messages', msg(da));

    const p1 = await B.get('/api/v1/messages?limit=2');
    expect(p1.body.data.messages).toHaveLength(2);
    const p2 = await B.get(`/api/v1/messages?limit=10&before=${p1.body.data.nextCursor}`);
    expect(p2.body.data.messages).toHaveLength(3);
    expect(Object.keys(p1.body.data.messages[0])).not.toContain('text');
    expect(await mongoose.connection.collection('messages').countDocuments()).toBeGreaterThanOrEqual(5);
  });
  test('rejects malformed payloads, foreign/revoked devices and outsiders', async () => {
    const { A, B, da, db } = await setup();
    expect((await A.post('/api/v1/messages', msg(da, { nonce: rnd(10) }))).status).toBe(400);
    expect((await A.post('/api/v1/messages', msg(da, { text: 'plaintext!' }))).status).toBe(400);
    expect((await A.post('/api/v1/messages', msg(db))).status).toBe(403); // B's device
    const outsider = authed(app, await registerUser(app));
    const od = await addDevice(outsider);
    expect((await outsider.post('/api/v1/messages', msg(od))).status).toBe(404);
    expect((await outsider.get('/api/v1/messages')).status).toBe(404);
    expect((await B.post('/api/v1/messages', msg(db))).status).toBe(201);
  });
  test('only the sender can delete; ciphertext is wiped', async () => {
    const { A, B, da } = await setup();
    const sent = (await A.post('/api/v1/messages', msg(da))).body.data.message;
    expect((await B.del(`/api/v1/messages/${sent.id}`)).status).toBe(404);
    expect((await A.del(`/api/v1/messages/${sent.id}`)).status).toBe(204);
    const row = await mongoose.connection.collection('messages').findOne({ clientMsgId: sent.clientMsgId });
    expect(row.ciphertext).toBeUndefined();
    expect((await B.get('/api/v1/messages')).body.data.messages[0]).toMatchObject({ deleted: true, ciphertext: null });
  });
  test('revoking a device bumps the key version and blocks stale sends', async () => {
    const { A, B, da, db } = await setup();
    const spare = await addDevice(B, 'old tablet');
    const rev = await B.del(`/api/v1/devices/${spare}`);
    expect(rev.body.data.keyVersion).toBe(2);
    const stale = await A.post('/api/v1/messages', msg(da, { keyVersion: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('KEY_VERSION_STALE');
    expect(stale.body.error.details.currentKeyVersion).toBe(2);
    expect((await A.post('/api/v1/messages', msg(da, { keyVersion: 2 }))).status).toBe(201);
    expect((await B.post('/api/v1/messages', msg(spare, { keyVersion: 2 }))).status).toBe(403); // revoked device
    expect(db).toBeTruthy();
  });
});

describe('recovery blob', () => {
  test('stores opaque data per user and is private', async () => {
    const U = authed(app, await registerUser(app));
    const other = authed(app, await registerUser(app));
    expect((await U.get('/api/v1/keys/recovery')).status).toBe(404);
    expect((await U.put('/api/v1/keys/recovery', { version: 1, nonce: rnd(24), ciphertext: rnd(300) })).status).toBe(204);
    expect((await U.get('/api/v1/keys/recovery')).body.data.ciphertext).toBeTruthy();
    expect((await other.get('/api/v1/keys/recovery')).status).toBe(404);
    expect((await U.del('/api/v1/keys/recovery')).status).toBe(204);
  });
});

describe('realtime encrypted messages', () => {
  const open = (token) => new Promise((resolve, reject) => {
    const c = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(c);
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const join = (c) => new Promise((r) => c.emit('couple:join', r));
  const waitFor = (c, evt, ms = 600) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    c.once(evt, (p) => { clearTimeout(t); resolve(p); });
  });

  test('message:send reaches the partner only, with ack; REST sends also push in realtime', async () => {
    const { a, b, A, da } = await setup();
    const outsider = await registerUser(app);
    const ca = await open(a.token);
    const cb = await open(b.token);
    const co = await open(outsider.token);
    await join(ca); await join(cb); await join(co);

    const gotB = waitFor(cb, 'message:new');
    const gotO = waitFor(co, 'message:new');
    const ack = await new Promise((r) => ca.emit('message:send', msg(da), r));
    expect(ack.ok).toBe(true);
    expect((await gotB).clientMsgId).toBe(ack.message.clientMsgId);
    expect(await gotO).toBeNull();

    const gotB2 = waitFor(cb, 'message:new');
    await A.post('/api/v1/messages', msg(da));
    expect(await gotB2).not.toBeNull();

    const bad = await new Promise((r) => ca.emit('message:send', { ...msg(da), keyVersion: 9 }, r));
    expect(bad).toMatchObject({ ok: false, error: 'KEY_VERSION_STALE' });
    const outAck = await new Promise((r) => co.emit('message:send', msg(da), r));
    expect(outAck.ok).toBe(false);
  });
});
