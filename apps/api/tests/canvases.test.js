const crypto = require('crypto');
const http = require('http');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachSockets } = require('../src/sockets');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
const rnd = (n) => crypto.randomBytes(n).toString('base64');
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

const addDevice = async (U) => (await U.post('/api/v1/devices', { publicKey: rnd(32), label: 'dev' })).body.data.device.id;
const op = (deviceId, over = {}) => ({ clientOpId: crypto.randomUUID(), deviceId, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(200), ...over });

async function setup() {
  const c = await makeCouple(app);
  c.da = await addDevice(c.A);
  c.db = await addDevice(c.B);
  c.canvas = (await c.A.post('/api/v1/canvases')).body.data.canvas;
  return c;
}

describe('canvases (REST)', () => {
  test('both partners see the canvas; outsiders and other couples cannot', async () => {
    const one = await setup();
    const two = await setup();
    expect((await one.B.get('/api/v1/canvases')).body.data.canvases.map((c) => c.id)).toContain(one.canvas.id);
    expect((await two.A.get('/api/v1/canvases')).body.data.canvases.map((c) => c.id)).not.toContain(one.canvas.id);
    expect((await two.A.get(`/api/v1/canvases/${one.canvas.id}/ops`)).status).toBe(404);
    expect((await two.A.post(`/api/v1/canvases/${one.canvas.id}/ops`, op(two.da))).status).toBe(404);
    const outsider = authed(app, await registerUser(app));
    expect((await outsider.get('/api/v1/canvases')).status).toBe(404);
    expect((await outsider.post('/api/v1/canvases')).status).toBe(404);
  });

  test('ops get increasing seq, are idempotent, paginate, and replay in order', async () => {
    const { A, B, da, db, canvas } = await setup();
    const url = `/api/v1/canvases/${canvas.id}/ops`;
    const o1 = op(da);
    const r1 = await A.post(url, o1);
    expect(r1.status).toBe(201);
    expect(r1.body.data.op.seq).toBe(1);
    const again = await A.post(url, o1);
    expect(again.status).toBe(200);
    expect(again.body.data.op.seq).toBe(1);
    expect((await B.post(url, op(db))).body.data.op.seq).toBe(2);
    await A.post(url, op(da));

    const page = await B.get(`${url}?since=0&limit=2`);
    expect(page.body.data.ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(page.body.data.hasMore).toBe(true);
    const rest = await B.get(`${url}?since=2`);
    expect(rest.body.data.ops.map((o) => o.seq)).toEqual([3]);
    expect(rest.body.data.hasMore).toBe(false);
    // server returns only ciphertext fields
    expect(Object.keys(rest.body.data.ops[0]).sort()).toEqual(['ciphertext', 'clientOpId', 'createdAt', 'keyVersion', 'nonce', 'senderDeviceId', 'senderId', 'seq']);
  });

  test('rejects stale key versions, foreign devices and malformed payloads', async () => {
    const { A, da, db, canvas } = await setup();
    const url = `/api/v1/canvases/${canvas.id}/ops`;
    const stale = await A.post(url, op(da, { keyVersion: 7 }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('KEY_VERSION_STALE');
    expect((await A.post(url, op(db))).status).toBe(403);
    expect((await A.post(url, op(da, { nonce: rnd(5) }))).status).toBe(400);
    expect((await A.post(url, { ...op(da), strokes: [] })).status).toBe(400);
  });

  test('favorite is per user; archive hides the canvas for both', async () => {
    const { A, B, canvas } = await setup();
    expect((await A.patch(`/api/v1/canvases/${canvas.id}`, { favorite: true })).body.data.canvas.favorite).toBe(true);
    expect((await B.get('/api/v1/canvases')).body.data.canvases[0].favorite).toBe(false);
    expect((await B.del(`/api/v1/canvases/${canvas.id}`)).status).toBe(204);
    expect((await A.get('/api/v1/canvases')).body.data.canvases).toHaveLength(0);
    expect((await A.get(`/api/v1/canvases/${canvas.id}/ops`)).status).toBe(404);
  });
});

describe('canvases (realtime)', () => {
  const open = (token) => new Promise((resolve, reject) => {
    const c = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(c);
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
  const emit = (c, evt, payload) => new Promise((r) => c.emit(evt, payload, r));
  const waitFor = (c, evt, ms = 600) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    c.once(evt, (p) => { clearTimeout(t); resolve(p); });
  });
  const join = async (c, canvasId) => { await emit(c, 'couple:join'); return emit(c, 'canvas:join', { canvasId }); };

  test('a new canvas is announced to the partner (and not to other couples)', async () => {
    const { a, b, A } = await setup();
    const stranger = await setup();
    const cb = await open(b.token);
    const cs = await open(stranger.a.token);
    await emit(cb, 'couple:join');
    await emit(cs, 'couple:join');
    const gotB = waitFor(cb, 'canvas:created');
    const gotS = waitFor(cs, 'canvas:created');
    const created = (await A.post('/api/v1/canvases')).body.data.canvas;
    expect((await gotB).canvasId).toBe(created.id);
    expect(await gotS).toBeNull();
    expect(a.user.id).toBeTruthy();
  });

  test('ops and live previews reach the partner only; other couples cannot join or inject', async () => {
    const { a, b, da, canvas } = await setup();
    const stranger = await setup();
    const ca = await open(a.token);
    const cb = await open(b.token);
    const cs = await open(stranger.a.token);

    expect((await join(ca, canvas.id)).ok).toBe(true);
    expect((await join(cb, canvas.id)).ok).toBe(true);
    const denied = await join(cs, canvas.id);
    expect(denied.ok).toBe(false);

    // persisted op: ack to sender, broadcast to partner, never to the stranger
    const gotB = waitFor(cb, 'canvas:op');
    const gotS = waitFor(cs, 'canvas:op');
    const ack = await emit(ca, 'canvas:op', { canvasId: canvas.id, ...op(da) });
    expect(ack.ok).toBe(true);
    expect(ack.op.seq).toBe(1);
    expect((await gotB).op.seq).toBe(1);
    expect(await gotS).toBeNull();

    // stranger cannot write to a canvas they never joined
    const inject = await emit(cs, 'canvas:op', { canvasId: canvas.id, ...op(stranger.da) });
    expect(inject).toMatchObject({ ok: false, error: 'NOT_JOINED' });

    // live preview: partner gets it with the server-assigned sender id
    const liveB = waitFor(cb, 'canvas:live');
    const liveS = waitFor(cs, 'canvas:live');
    ca.emit('canvas:live', { canvasId: canvas.id, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(100) });
    expect((await liveB).senderId).toBe(a.user.id);
    expect(await liveS).toBeNull();

    // a spoofed senderId in the payload is rejected by the strict schema (no event)
    const spoof = waitFor(cb, 'canvas:live');
    ca.emit('canvas:live', { canvasId: canvas.id, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(100), senderId: b.user.id });
    expect(await spoof).toBeNull();
  });
});
