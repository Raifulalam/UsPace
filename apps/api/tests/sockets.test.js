const http = require('http');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../src/app');
const { attachSockets } = require('../src/sockets');
const { startDb, stopDb, registerUser, makeCouple } = require('./helpers');

let server, io, port;
const clients = [];

beforeAll(async () => {
  await startDb();
  server = http.createServer(createApp());
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

const open = (token) =>
  new Promise((resolve, reject) => {
    const c = connect(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
    clients.push(c);
    c.on('connect', () => resolve(c));
    c.on('connect_error', (e) => reject(e));
  });
const join = (c) => new Promise((r) => c.emit('couple:join', r));
const waitFor = (c, evt, ms = 500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    c.once(evt, (p) => { clearTimeout(t); resolve(p); });
  });

test('rejects connections without a valid token', async () => {
  await expect(open('garbage')).rejects.toThrow('unauthorized');
});

test('a user without an active couple cannot join any room', async () => {
  const u = await registerUser(createApp());
  const c = await open(u.token);
  expect(await join(c)).toEqual({ ok: false, error: 'NO_ACTIVE_COUPLE' });
});

test('partners exchange typing events; outsiders and non-joined sockets receive nothing', async () => {
  const { a, b } = await makeCouple(createApp());
  const outsider = await registerUser(createApp());
  const ca = await open(a.token);
  const cb = await open(b.token);
  const co = await open(outsider.token);
  expect((await join(ca)).ok).toBe(true);
  expect((await join(cb)).ok).toBe(true);
  await join(co);

  const gotB = waitFor(cb, 'typing:update');
  const gotO = waitFor(co, 'typing:update');
  ca.emit('typing:start');
  expect(await gotB).toEqual({ userId: a.user.id, typing: true });
  expect(await gotO).toBeNull();

  // Outsider emitting typing:start reaches nobody (no joined room).
  const gotA = waitFor(ca, 'typing:update');
  co.emit('typing:start');
  expect(await gotA).toBeNull();
});
