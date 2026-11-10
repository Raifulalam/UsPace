const crypto = require('crypto');
const http = require('http');
const request = require('supertest');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachSockets } = require('../src/sockets');
const calls = require('../src/services/callService');
const settings = require('../src/services/settingsService');
const retention = require('../src/services/retentionService');
const CallHistory = require('../src/models/CallHistory');
const Couple = require('../src/models/Couple');
const mongoose = require('mongoose');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
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

const rnd = (n) => crypto.randomBytes(n).toString('base64');
const uuid = () => crypto.randomUUID();
const open = (token) => new Promise((resolve, reject) => {
  const c = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(c);
  c.on('connect', () => resolve(c));
  c.on('connect_error', reject);
});
const emit = (c, evt, payload) => new Promise((r) => (payload === undefined ? c.emit(evt, r) : c.emit(evt, payload, r)));
const waitFor = (c, evt, ms = 700) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(null), ms);
  c.once(evt, (p) => { clearTimeout(t); resolve(p); });
});
const signal = (callId, over = {}) => ({ callId, keyVersion: 1, nonce: rnd(24), ciphertext: rnd(300), ...over });
const history = (U) => U.get('/api/v1/calls/history');

// Two partners, both online and joined to their room.
async function online() {
  const c = await makeCouple(app);
  c.sa = await open(c.a.token);
  c.sb = await open(c.b.token);
  await emit(c.sa, 'couple:join');
  await emit(c.sb, 'couple:join');
  return c;
}

test('a full call: ring, answer, encrypted setup relayed untouched, hang up, history with duration', async () => {
  const { a, b, A, B, sa, sb } = await online();
  const callId = uuid();
  const incoming = waitFor(sb, 'call:incoming');
  const started = await emit(sa, 'call:start', { callId, type: 'video' });
  expect(started).toMatchObject({ ok: true, state: 'ringing' });
  expect(await incoming).toEqual({ callId, type: 'video', from: a.user.id });

  const busy = await emit(sa, 'call:start', { callId: uuid(), type: 'audio' });
  expect(busy).toMatchObject({ ok: false, error: 'BUSY' }); // one call per room
  expect(await emit(sa, 'call:signal', signal(callId))).toMatchObject({ ok: false, error: 'CALL_NOT_ACTIVE' }); // nothing to relay before it is answered

  const answeredA = waitFor(sa, 'call:answered');
  expect(await emit(sb, 'call:answer', { callId })).toMatchObject({ ok: true });
  expect(await answeredA).toEqual({ callId });

  const offer = signal(callId);
  const gotOffer = waitFor(sb, 'call:signal');
  expect(await emit(sa, 'call:signal', offer)).toMatchObject({ ok: true });
  expect(await gotOffer).toEqual({ callId, from: a.user.id, keyVersion: 1, nonce: offer.nonce, ciphertext: offer.ciphertext }); // byte-for-byte, sender id added by the server
  const reply = signal(callId);
  const gotReply = waitFor(sa, 'call:signal');
  await emit(sb, 'call:signal', reply);
  expect((await gotReply).from).toBe(b.user.id);

  await new Promise((r) => setTimeout(r, 1100));
  const endedB = waitFor(sb, 'call:ended');
  expect(await emit(sa, 'call:end', { callId })).toMatchObject({ ok: true });
  expect(await endedB).toMatchObject({ callId, reason: 'hangup', by: a.user.id });
  expect(await emit(sa, 'call:signal', signal(callId))).toMatchObject({ ok: false, error: 'CALL_NOT_ACTIVE' });

  const ha = (await history(A)).body.data.calls[0];
  expect(ha).toMatchObject({ id: callId, direction: 'outgoing', type: 'video', status: 'ended', withUserId: b.user.id });
  expect(ha.durationSec).toBeGreaterThanOrEqual(1);
  expect((await history(B)).body.data.calls[0]).toMatchObject({ id: callId, direction: 'incoming', status: 'ended' });
  expect((await emit(sa, 'call:start', { callId: uuid(), type: 'audio' })).state).toBe('ringing'); // free again afterwards
});

test('an offline partner gets a missed call instead of a ring', async () => {
  const c = await makeCouple(app);
  const sa = await open(c.a.token);
  await emit(sa, 'couple:join');
  const r = await emit(sa, 'call:start', { callId: uuid(), type: 'audio' });
  expect(r).toMatchObject({ ok: true, state: 'offline' });
  const entry = (await history(c.B)).body.data.calls[0];
  expect(entry).toMatchObject({ direction: 'incoming', status: 'missed', reason: 'offline' });
  expect(await CallHistory.countDocuments({ active: true, coupleId: (await Couple.findOne({ members: c.a.user.id }))._id })).toBe(0);
});

test('reject, cancel and no-answer all end the call cleanly and free the room', async () => {
  const { a, b, sa, sb, A } = await online();
  let id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'audio' });
  const endedA = waitFor(sa, 'call:ended');
  expect(await emit(sb, 'call:reject', { callId: id })).toMatchObject({ ok: true });
  expect(await endedA).toMatchObject({ callId: id, reason: 'rejected' });

  id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'audio' });
  const endedB = waitFor(sb, 'call:ended');
  await emit(sa, 'call:end', { callId: id }); // the caller hangs up before an answer
  expect(await endedB).toMatchObject({ callId: id, reason: 'canceled' });

  id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'video' });
  const timeoutA = waitFor(sa, 'call:ended');
  await calls.expire(id); // what the 45-second ring timer does
  expect(await timeoutA).toMatchObject({ callId: id, reason: 'no-answer' });
  expect(await emit(sb, 'call:answer', { callId: id })).toMatchObject({ ok: false, error: 'CALL_NOT_RINGING' }); // too late
  const statuses = (await history(A)).body.data.calls.map((c) => c.status);
  expect(statuses).toEqual(['missed', 'canceled', 'rejected']);
  expect(a.user.id && b.user.id).toBeTruthy();
});

test('only the right person can answer; strangers and users without a room can do nothing', async () => {
  const { sa, sb } = await online();
  const other = await online();
  const lone = await registerUser(app);
  const sl = await open(lone.token);
  const id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'audio' });

  expect(await emit(sa, 'call:answer', { callId: id })).toMatchObject({ ok: false, error: 'CALL_NOT_RINGING' }); // the caller cannot answer their own call
  expect(await emit(other.sa, 'call:answer', { callId: id })).toMatchObject({ ok: false }); // another couple
  expect(await emit(other.sa, 'call:end', { callId: id })).toMatchObject({ ok: false, error: 'CALL_NOT_ACTIVE' });
  expect(await emit(sl, 'call:start', { callId: uuid(), type: 'audio' })).toMatchObject({ ok: false, error: 'NO_ACTIVE_COUPLE' });

  await emit(sb, 'call:answer', { callId: id });
  const leaked = waitFor(other.sb, 'call:signal');
  expect(await emit(other.sa, 'call:signal', signal(id))).toMatchObject({ ok: false, error: 'CALL_NOT_ACTIVE' });
  expect(await leaked).toBeNull(); // the stranger's attempt reached nobody
  expect(await emit(sb, 'call:answer', { callId: id })).toMatchObject({ ok: false, error: 'CALL_NOT_RINGING' }); // not twice
});

test('input is validated and rate limits exist', async () => {
  const { sa } = await online();
  expect(await emit(sa, 'call:start', { callId: 'nope', type: 'audio' })).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  expect(await emit(sa, 'call:start', { callId: uuid(), type: 'hologram' })).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  expect(await emit(sa, 'call:start', { callId: uuid(), type: 'audio', extra: 1 })).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  const id = uuid();
  expect(await emit(sa, 'call:signal', signal(id, { ciphertext: rnd(30000) }))).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  expect(await emit(sa, 'call:signal', { ...signal(id), sdp: 'v=0' })).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' }); // plaintext SDP is refused
  for (let i = 0; i < 6; i++) await emit(sa, 'call:end', { callId: uuid() });
  const lim = [];
  for (let i = 0; i < 8; i++) lim.push(await emit(sa, 'call:start', { callId: uuid(), type: 'audio' }));
  expect(lim.some((r) => r.error === 'RATE_LIMITED')).toBe(true);
});

test('a lost connection ends the call; stale calls are swept', async () => {
  const { a, b, sa, sb } = await online();
  const id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'audio' });
  await emit(sb, 'call:answer', { callId: id });
  const endedA = waitFor(sa, 'call:ended');
  await calls.endActiveCallFor(b.user.id, 'connection-lost'); // what runs after the 15-second grace period
  expect(await endedA).toMatchObject({ callId: id, reason: 'connection-lost', by: b.user.id });

  const couple = await Couple.findOne({ members: a.user.id });
  await CallHistory.create({ coupleId: couple._id, callId: uuid(), callerId: a.user.id, calleeId: b.user.id, type: 'audio', status: 'ringing', active: true, startedAt: new Date(Date.now() - 10 * 60000) });
  expect((await calls.sweepStale()).ringing).toBeGreaterThanOrEqual(1);
  expect(await CallHistory.countDocuments({ coupleId: couple._id, active: true })).toBe(0);
});

test('history: each person hides their own view; an entry is deleted once both hide it', async () => {
  const { a, b, sa, sb, A, B } = await online();
  const make = async () => { const id = uuid(); await emit(sa, 'call:start', { callId: id, type: 'audio' }); await emit(sb, 'call:reject', { callId: id }); return id; };
  const [one, two] = [await make(), await make()];
  expect((await history(A)).body.data.calls).toHaveLength(2);
  expect((await A.del(`/api/v1/calls/history/${one}`)).status).toBe(204);
  expect((await history(A)).body.data.calls.map((c) => c.id)).toEqual([two]);
  expect((await history(B)).body.data.calls).toHaveLength(2); // the partner still sees it
  expect((await B.del(`/api/v1/calls/history/${one}`)).status).toBe(204);
  expect(await CallHistory.countDocuments({ callId: one })).toBe(0); // gone for good
  expect((await A.del('/api/v1/calls/history')).status).toBe(204);
  expect((await history(A)).body.data.calls).toHaveLength(0);
  expect((await history(B)).body.data.calls).toHaveLength(1);
  expect((await A.del(`/api/v1/calls/history/${uuid()}`)).status).toBe(404);
  expect((await A.del('/api/v1/calls/history/not-a-uuid')).status).toBe(400);
  const outsider = authed(app, await registerUser(app));
  expect((await outsider.get('/api/v1/calls/history')).status).toBe(404);
  expect(a.user.id && b.user.id).toBeTruthy();
});

test('relay credentials: STUN plus short-lived TURN credentials, only for people in a room', async () => {
  const { a, A } = await makeCouple(app);
  const r = await A.get('/api/v1/calls/ice');
  expect(r.status).toBe(200);
  const servers = r.body.data.iceServers;
  expect(servers[0].urls[0]).toMatch(/^stun:/);
  const turn = servers.find((s) => s.credential);
  expect(turn.urls).toEqual(['turn:turn.test:3478', 'turns:turn.test:5349']);
  const [expiry, who] = turn.username.split(':');
  expect(who).toBe(a.user.id);
  expect(Number(expiry)).toBeGreaterThan(Date.now() / 1000);
  expect(Number(expiry)).toBeLessThanOrEqual(Date.now() / 1000 + 3601);
  expect(turn.credential).toBe(crypto.createHmac('sha1', process.env.TURN_SECRET).update(turn.username).digest('base64'));
  expect(JSON.stringify(r.body)).not.toContain(process.env.TURN_SECRET);
  expect((await authed(app, await registerUser(app)).get('/api/v1/calls/ice')).status).toBe(404);
});

test('the admin "calls" switch turns calling off immediately', async () => {
  const { sa } = await online();
  try {
    await settings.update({ features: { calls: false } }, 'test');
    expect(await emit(sa, 'call:start', { callId: uuid(), type: 'audio' })).toMatchObject({ ok: false, error: 'FEATURE_DISABLED' });
    const c = await makeCouple(app);
    const r = await c.A.get('/api/v1/calls/history');
    expect(r.status).toBe(403);
  } finally { await settings.update({ features: { calls: true } }, 'test'); }
});

test('call history is erased with a closed room', async () => {
  const { A, sa, sb } = await online();
  const id = uuid();
  await emit(sa, 'call:start', { callId: id, type: 'audio' });
  await emit(sb, 'call:reject', { callId: id });
  const row = await CallHistory.findOne({ callId: id });
  await A.post('/api/v1/couples/me/leave');
  await Couple.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(row.coupleId)) }, { $set: { closedAt: new Date(Date.now() - 40 * 86400000) } });
  await retention.sweep();
  expect(await CallHistory.countDocuments({ callId: id })).toBe(0);
});
