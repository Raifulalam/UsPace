const request = require('supertest');
const { createApp } = require('../src/app');
const User = require('../src/models/User');
const Report = require('../src/models/Report');
const Invitation = require('../src/models/Invitation');
const { sha256 } = require('../src/utils/crypto');
const { startDb, stopDb, registerUser, authed, makeCouple, cookieOf, PASSWORD } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const NEW = 'An0ther!Passw0rd';
const DAY = 86400000;
const bearer = (token, cookie) => (r) => { r.set('Authorization', `Bearer ${token}`); if (cookie) r.set('Cookie', cookie); return r; };
const login = async (u, password = PASSWORD) => {
  const res = await request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password });
  return { res, token: res.body.data?.accessToken, cookie: res.status === 200 ? cookieOf(res) : null };
};
const refresh = (cookie) => request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
const me = (token) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

describe('password reset and change', () => {
  test('forgot-password is identical for known and unknown emails, and only real accounts get a token', async () => {
    const u = await registerUser(app);
    const known = await request(app).post('/api/v1/auth/password/forgot').send({ email: u.body.email });
    const unknown = await request(app).post('/api/v1/auth/password/forgot').send({ email: 'nobody@example.com' });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect((await User.findOne({ email: u.body.email }).select('+resetTokenHash')).resetTokenHash).toBeTruthy();
    expect((await request(app).post('/api/v1/auth/password/forgot').send({ email: 'not-an-email' })).status).toBe(400);
  });

  test('reset sets the new password, signs out every device, and the link works only once', async () => {
    const u = await registerUser(app);
    const token = 'known-reset-token-0123456789';
    await User.updateOne({ _id: u.user.id }, { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + 3600000) });
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW })).status).toBe(204);
    expect((await login(u)).res.status).toBe(401);
    expect((await login(u, NEW)).res.status).toBe(200);
    expect((await refresh(u.cookie)).status).toBe(401);
    expect((await me(u.token)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW })).status).toBe(400);
  });

  test('an expired reset token is rejected', async () => {
    const u = await registerUser(app);
    const token = 'expired-reset-token-0123456789';
    await User.updateOne({ _id: u.user.id }, { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() - 1000) });
    const r = await request(app).post('/api/v1/auth/password/reset').send({ token, password: NEW });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_RESET');
  });

  test('changing the password needs the current one, keeps this device signed in and signs the others out', async () => {
    const u = await registerUser(app);
    const other = await login(u);
    const change = (current) => bearer(u.token, u.cookie)(request(app).post('/api/v1/users/me/password')).send({ currentPassword: current, newPassword: NEW });
    expect((await change('wrong-password-123')).status).toBe(403);
    const ok = await change(PASSWORD);
    expect(ok.status).toBe(200);
    expect((await me(ok.body.data.accessToken)).status).toBe(200);
    expect((await me(u.token)).status).toBe(401);
    expect((await refresh(u.cookie)).status).toBe(200);
    expect((await refresh(other.cookie)).status).toBe(401);
    expect((await login(u, NEW)).res.status).toBe(200);
  });
});

describe('sessions', () => {
  test('list, revoke one, revoke all', async () => {
    const u = await registerUser(app);
    const s2 = await login(u);
    const list = await bearer(u.token, u.cookie)(request(app).get('/api/v1/users/me/sessions'));
    expect(list.body.data.sessions).toHaveLength(2);
    expect(list.body.data.sessions.filter((s) => s.current)).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|userAgent|127\.0\.0\.1/);

    const other = list.body.data.sessions.find((s) => !s.current);
    expect((await bearer(u.token)(request(app).delete(`/api/v1/users/me/sessions/${other.id}`))).status).toBe(204);
    expect((await refresh(s2.cookie)).status).toBe(401);
    expect((await bearer(u.token)(request(app).delete(`/api/v1/users/me/sessions/${other.id}`))).status).toBe(404);
    expect((await bearer(u.token)(request(app).delete('/api/v1/users/me/sessions/not-a-uuid'))).status).toBe(400);

    expect((await bearer(u.token)(request(app).post('/api/v1/users/me/sessions/revoke-all'))).status).toBe(204);
    expect((await refresh(u.cookie)).status).toBe(401);
    expect((await me(u.token)).status).toBe(401);
  });
});

describe('account deletion and export', () => {
  test('deletion needs the password, closes the room, blocks sign-in, and can be cancelled during the grace period', async () => {
    const { a, A, B } = await makeCouple(app);
    expect((await A.post('/api/v1/users/me/deletion', { password: 'wrong-password-123' })).status).toBe(403);
    const ok = await A.post('/api/v1/users/me/deletion', { password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.data.scheduledFor).getTime()).toBeGreaterThan(Date.now() + 13 * DAY);
    expect((await User.findById(a.user.id)).status).toBe('pending_deletion');
    expect((await B.get('/api/v1/couples/me')).status).toBe(404); // the partner's room was closed
    expect((await login(a)).res.status).toBe(403);
    const cancel = (password) => request(app).post('/api/v1/auth/deletion/cancel').send({ identifier: a.body.username, password });
    expect((await cancel('wrong-password-123')).status).toBe(403);
    expect((await cancel(PASSWORD)).status).toBe(204);
    expect((await User.findById(a.user.id)).status).toBe('active');
    expect((await login(a)).res.status).toBe(200);
  });

  test('export contains account data and counts but never secrets or content', async () => {
    const { a, A } = await makeCouple(app);
    const r = await A.get('/api/v1/users/me/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    const d = r.body.data;
    expect(Object.keys(d).sort()).toEqual(['account', 'blockedUsers', 'counts', 'couple', 'devices', 'exportedAt', 'note', 'reportsFiled', 'sessions']);
    expect(d.account.email).toBe(a.body.email);
    expect(d.account.birthDate).toBe('1995-05-05');
    expect(d.couple.status).toBe('active');
    expect(JSON.stringify(d)).not.toMatch(/passwordHash|tokenHash|resetToken/);
    expect(d.note).toMatch(/end-to-end encrypted/);
  });
});

describe('blocks and invitation abuse', () => {
  test('a blocked person is told nothing: their code simply fails, until unblocked', async () => {
    const A = authed(app, await registerUser(app));
    const bUser = await registerUser(app);
    const B = authed(app, bUser);
    await A.post('/api/v1/couples', {});
    const inv = await A.post('/api/v1/couples/me/invitations');
    expect((await A.post('/api/v1/safety/blocks', { username: bUser.body.username })).status).toBe(204);
    expect((await A.get('/api/v1/safety/blocks')).body.data.usernames).toEqual([bUser.body.username]);
    const blocked = await B.post('/api/v1/invitations/accept', { code: inv.body.data.code });
    expect(blocked.status).toBe(404);
    expect(blocked.body.error.code).toBe('INVALID_INVITATION');
    expect((await A.post('/api/v1/safety/blocks', { username: 'no_such_user_x' })).status).toBe(204); // no oracle for unknown names
    expect((await A.get('/api/v1/safety/blocks')).body.data.usernames).toHaveLength(1);
    expect((await A.del(`/api/v1/safety/blocks/${bUser.body.username}`)).status).toBe(204);
    expect((await B.post('/api/v1/invitations/accept', { code: inv.body.data.code })).status).toBe(200);
  });

  test('blocking after someone asked to join stops the confirmation', async () => {
    const A = authed(app, await registerUser(app));
    const bUser = await registerUser(app);
    const B = authed(app, bUser);
    await A.post('/api/v1/couples', {});
    const inv = await A.post('/api/v1/couples/me/invitations');
    await B.post('/api/v1/invitations/accept', { code: inv.body.data.code });
    await A.post('/api/v1/safety/blocks', { username: bUser.body.username });
    const confirm = await A.post(`/api/v1/couples/me/invitations/${inv.body.data.invitation.id}/confirm`);
    expect(confirm.status).toBe(409);
    expect((await Invitation.findById(inv.body.data.invitation.id)).status).toBe('rejected');
    expect((await B.get('/api/v1/couples/me')).status).toBe(404);
  });

  test('at most 10 invitations per day', async () => {
    const A = authed(app, await registerUser(app));
    await A.post('/api/v1/couples', {});
    for (let i = 0; i < 10; i++) {
      const r = await A.post('/api/v1/couples/me/invitations');
      expect(r.status).toBe(201);
      await A.del(`/api/v1/couples/me/invitations/${r.body.data.invitation.id}`);
    }
    const over = await A.post('/api/v1/couples/me/invitations');
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('TOO_MANY_INVITES');
  });
});

describe('reports', () => {
  test('reporting the partner records the room; unknown usernames give no hint; input is validated', async () => {
    const { a, b, A } = await makeCouple(app);
    expect((await A.post('/api/v1/safety/reports', { category: 'harassment', target: 'partner', details: 'please look into this' })).status).toBe(201);
    const r = await Report.findOne({ reporterId: a.user.id });
    expect(String(r.targetUserId)).toBe(b.user.id);
    expect(r.coupleId).toBeTruthy();
    expect(r.status).toBe('open');
    expect((await A.post('/api/v1/safety/reports', { category: 'spam', target: 'user', username: 'nobody_here' })).status).toBe(201);
    expect((await A.post('/api/v1/safety/reports', { category: 'spam', target: 'user' })).status).toBe(400);
    expect((await A.post('/api/v1/safety/reports', { category: 'made-up', target: 'partner' })).status).toBe(400);
    expect((await A.post('/api/v1/safety/reports', { category: 'other', target: 'partner', details: 'x'.repeat(1001) })).status).toBe(400);
    expect((await A.post('/api/v1/safety/reports', { category: 'other', target: 'partner', reporterId: 'x' })).status).toBe(400);
    const lone = authed(app, await registerUser(app));
    expect((await lone.post('/api/v1/safety/reports', { category: 'other', target: 'partner' })).status).toBe(404);
  });

  test('at most 5 reports per day', async () => {
    const { A } = await makeCouple(app);
    for (let i = 0; i < 5; i++) expect((await A.post('/api/v1/safety/reports', { category: 'other', target: 'partner' })).status).toBe(201);
    expect((await A.post('/api/v1/safety/reports', { category: 'other', target: 'partner' })).status).toBe(429);
  });
});
