const request = require('supertest');
const { createApp } = require('../src/app');
const AdminAccount = require('../src/models/AdminAccount');
const AdminAuditLog = require('../src/models/AdminAuditLog');
const { startDb, stopDb, registerUser, authed } = require('./helpers');
const { PASS, makeAdmin, login, mfa, signIn, adminOf, T } = require('./adminHelpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

test('invite -> set password -> enrol authenticator -> sign in with codes; replays and recovery codes behave', async () => {
  const root = await adminOf(app, 'superadmin');
  const inv = await root.api.post('/admins', { email: 'new.admin@company.test', role: 'moderator' });
  expect(inv.status).toBe(201);
  const token = inv.body.data.setupToken;
  expect(inv.body.data.setupUrl).toContain(token);
  expect((await root.api.post('/admins', { email: 'new.admin@company.test', role: 'moderator' })).status).toBe(409);

  const setupReq = (body) => request(app).post('/api/v1/admin/auth/setup').send(body);
  expect((await setupReq({ token, password: 'short' })).status).toBe(400);
  const setup = await setupReq({ token, password: PASS });
  expect(setup.status).toBe(200);
  expect(setup.body.data.stage).toBe('enroll');
  const secret = setup.body.data.secret;
  expect(setup.body.data.otpauthUri).toContain(secret);
  expect((await setupReq({ token, password: PASS })).status).toBe(400); // the link works once

  const enroll = (code) => request(app).post('/api/v1/admin/auth/enroll').send({ preAuthToken: setup.body.data.preAuthToken, code });
  expect((await enroll('000000')).status).toBe(401);
  const done = await enroll(T.totp(secret));
  expect(done.status).toBe(200);
  expect(done.body.data.recoveryCodes).toHaveLength(10);
  expect(done.body.data.admin.role).toBe('moderator');
  expect(done.headers['set-cookie'][0]).toMatch(/art=.*HttpOnly.*SameSite=Strict/i);
  expect(done.headers['set-cookie'][0]).toMatch(/Path=\/api\/v1\/admin\/auth/);
  expect((await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${done.body.data.accessToken}`)).status).toBe(200);

  // Signing in again needs a code. The code used while enrolling cannot be replayed.
  const l1 = await login(app, 'new.admin@company.test');
  expect(l1.body.data.stage).toBe('mfa');
  expect((await mfa(app, l1.body.data.preAuthToken, T.totp(secret))).status).toBe(401);
  expect((await mfa(app, l1.body.data.preAuthToken, T.totp(secret, Date.now() + 30000))).status).toBe(200);

  // A recovery code (lost phone) works exactly once.
  const code0 = done.body.data.recoveryCodes[0];
  const l2 = await login(app, 'new.admin@company.test');
  expect((await mfa(app, l2.body.data.preAuthToken, code0)).status).toBe(200);
  const l3 = await login(app, 'new.admin@company.test');
  expect((await mfa(app, l3.body.data.preAuthToken, code0)).status).toBe(401);
  expect(await AdminAuditLog.countDocuments({ action: 'auth.recovery_code_used' })).toBeGreaterThanOrEqual(1);
});

test('wrong passwords give one generic answer and lock the account after 5 failures', async () => {
  const a = await makeAdmin('support');
  const wrong = () => login(app, a.email, 'wrong-password-123');
  const unknown = await login(app, 'nobody@company.test', 'wrong-password-123');
  const first = await wrong();
  expect(first.status).toBe(401);
  expect(first.body.error).toEqual(unknown.body.error);
  for (let i = 0; i < 4; i++) expect((await wrong()).status).toBe(401);
  const locked = await login(app, a.email); // even the right password is refused while locked
  expect(locked.status).toBe(429);
  expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  expect(await AdminAuditLog.countDocuments({ action: 'auth.locked', adminEmail: a.email })).toBe(1);
  expect(await AdminAuditLog.countDocuments({ action: 'auth.login_failed', adminEmail: a.email })).toBeGreaterThanOrEqual(5);
});

test('guessing authenticator codes also locks the account', async () => {
  const a = await makeAdmin('moderator');
  const l = await login(app, a.email);
  for (let i = 0; i < 5; i++) expect((await mfa(app, l.body.data.preAuthToken, '000000')).status).toBe(401);
  const right = await mfa(app, l.body.data.preAuthToken, T.totp(a.secret));
  expect(right.status).toBe(429);
});

test('tokens are not interchangeable between admins, users and sign-in steps', async () => {
  const root = await adminOf(app, 'superadmin');
  const adminGet = (token) => request(app).get('/api/v1/admin/stats').set('Authorization', `Bearer ${token}`);
  expect((await request(app).get('/api/v1/admin/stats')).status).toBe(401);
  expect((await adminGet('garbage')).status).toBe(401);

  const consumer = await registerUser(app);
  expect((await adminGet(consumer.token)).status).toBe(401); // a couples-app session is never an admin session
  expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${root.token}`)).status).toBe(401); // and vice versa

  const a = await makeAdmin('moderator');
  const l = await login(app, a.email);
  expect((await adminGet(l.body.data.preAuthToken)).status).toBe(401); // a half-finished sign-in is not a session
  const wrongStage = await request(app).post('/api/v1/admin/auth/enroll').send({ preAuthToken: l.body.data.preAuthToken, code: T.totp(a.secret) });
  expect(wrongStage.status).toBe(401);
});

test('refresh rotates; replaying an old token ends the session; logout revokes', async () => {
  const a = await adminOf(app, 'superadmin');
  const refresh = (cookie) => request(app).post('/api/v1/admin/auth/refresh').set('Cookie', cookie);
  const r1 = await refresh(a.cookie);
  expect(r1.status).toBe(200);
  const newer = r1.headers['set-cookie'][0].split(';')[0];
  expect((await refresh(a.cookie)).status).toBe(401); // reuse of a rotated token
  expect((await refresh(newer)).status).toBe(401); // the whole family is now revoked
  expect(await AdminAuditLog.countDocuments({ action: 'auth.refresh_reuse' })).toBeGreaterThanOrEqual(1);

  const b = await adminOf(app, 'support');
  expect((await request(app).post('/api/v1/admin/auth/logout').set('Cookie', b.cookie)).status).toBe(204);
  expect((await refresh(b.cookie)).status).toBe(401);
});

test('every role is held to its permissions over HTTP', async () => {
  const support = await adminOf(app, 'support');
  const mod = await adminOf(app, 'moderator');
  const root = await adminOf(app, 'superadmin');
  const fakeId = '0123456789abcdef01234567';
  expect((await support.api.get('/users')).status).toBe(200);
  expect((await support.api.get('/reports')).status).toBe(200);
  expect((await support.api.post(`/users/${fakeId}/suspend`, { reason: 'because' })).status).toBe(403);
  expect((await support.api.post(`/reports/${fakeId}/handle`, { status: 'dismissed' })).status).toBe(403);
  for (const path of ['/settings', '/audit', '/admins']) expect((await support.api.get(path)).status).toBe(403);
  expect((await mod.api.post(`/users/${fakeId}/suspend`, { reason: 'because' })).status).toBe(404); // allowed, user just doesn't exist
  for (const path of ['/settings', '/audit', '/admins']) expect((await mod.api.get(path)).status).toBe(403);
  expect((await mod.api.patch('/settings', { appName: 'Hacked' })).status).toBe(403);
  for (const path of ['/settings', '/audit', '/admins', '/stats', '/alerts']) expect((await root.api.get(path)).status).toBe(200);
  expect((await AdminAccount.findById(root.admin._id)).role).toBe('superadmin');
});
