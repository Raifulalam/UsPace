const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

test('full invitation flow: create -> invite -> accept -> confirm', async () => {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const A = authed(app, a);
  const B = authed(app, b);

  const created = await A.post('/api/v1/couples', { name: 'Home' });
  expect(created.status).toBe(201);
  const inv = await A.post('/api/v1/couples/me/invitations');
  expect(inv.body.data.code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/);

  // The code itself is not stored anywhere in plaintext.
  const raw = await mongoose.connection.collection('invitations').findOne({});
  expect(JSON.stringify(raw)).not.toContain(inv.body.data.code);

  const accepted = await B.post('/api/v1/invitations/accept', { code: inv.body.data.code.toLowerCase() });
  expect(accepted.status).toBe(200);
  // Accepting alone grants NO access to the room.
  expect((await B.get('/api/v1/couples/me')).status).toBe(404);

  const confirmed = await A.post(`/api/v1/couples/me/invitations/${inv.body.data.invitation.id}/confirm`);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.data.couple.status).toBe('active');
  expect(confirmed.body.data.couple.members).toHaveLength(2);
  expect((await B.get('/api/v1/couples/me')).body.data.couple.id).toBe(created.body.data.couple.id);
});

test('a used code cannot be reused by a third person; inviter cannot accept own code', async () => {
  const { A } = await makeCouple(app);
  const c = await registerUser(app);
  const d = await registerUser(app);
  const C = authed(app, c);
  const D = authed(app, d);

  await C.post('/api/v1/couples', {});
  const inv = await C.post('/api/v1/couples/me/invitations');
  // C already has a room, so accepting any code (including their own) is refused with 409.
  expect((await C.post('/api/v1/invitations/accept', { code: inv.body.data.code })).status).toBe(409);
  expect((await D.post('/api/v1/invitations/accept', { code: inv.body.data.code })).status).toBe(200);
  const e = await registerUser(app);
  expect((await authed(app, e).post('/api/v1/invitations/accept', { code: inv.body.data.code })).status).toBe(404);
  expect((await A.get('/api/v1/couples/me/invitations')).body.data.invitations).toHaveLength(0);
});

test('cross-couple isolation: users only ever see their own couple', async () => {
  const one = await makeCouple(app);
  const two = await makeCouple(app);
  const r1 = await one.A.get('/api/v1/couples/me');
  const r2 = await two.A.get('/api/v1/couples/me');
  expect(r1.body.data.couple.id).not.toBe(r2.body.data.couple.id);
  const outsider = authed(app, await registerUser(app));
  expect((await outsider.get('/api/v1/couples/me')).status).toBe(404);
  expect((await outsider.patch('/api/v1/couples/me', { name: 'hijack' })).status).toBe(404);
  // A client-supplied couple id in the body is rejected by strict validation.
  expect((await outsider.patch('/api/v1/couples/me', { coupleId: r1.body.data.couple.id, name: 'x' })).status).toBe(400);
});

test('one couple per user; inviter can reject; revoke works', async () => {
  const { A } = await makeCouple(app);
  expect((await A.post('/api/v1/couples', {})).status).toBe(409);

  const a = authed(app, await registerUser(app));
  const b = authed(app, await registerUser(app));
  await a.post('/api/v1/couples', {});
  const inv = await a.post('/api/v1/couples/me/invitations');
  await b.post('/api/v1/invitations/accept', { code: inv.body.data.code });
  const rej = await a.post(`/api/v1/couples/me/invitations/${inv.body.data.invitation.id}/reject`);
  expect(rej.body.data.invitation.status).toBe('rejected');
  expect((await b.get('/api/v1/couples/me')).status).toBe(404);

  const inv2 = await a.post('/api/v1/couples/me/invitations');
  expect((await a.del(`/api/v1/couples/me/invitations/${inv2.body.data.invitation.id}`)).status).toBe(204);
  expect((await b.post('/api/v1/invitations/accept', { code: inv2.body.data.code })).status).toBe(404);
});

test('leaving closes the room and frees both partners', async () => {
  const { A, B } = await makeCouple(app);
  expect((await A.post('/api/v1/couples/me/leave')).status).toBe(204);
  expect((await A.get('/api/v1/couples/me')).status).toBe(404);
  expect((await B.get('/api/v1/couples/me')).status).toBe(404);
  expect((await B.post('/api/v1/couples', {})).status).toBe(201);
});
