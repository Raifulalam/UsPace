const request = require('supertest');
const { createApp } = require('../src/app');
const AdminAuditLog = require('../src/models/AdminAuditLog');
const { startDb, stopDb, registerUser, authed, makeCouple, PASSWORD } = require('./helpers');
const { adminOf, makeAdmin, login, mfa, signIn, T } = require('./adminHelpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const consumerLogin = (u, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password });
const auditActions = async () => (await AdminAuditLog.find().sort({ seq: 1 }).lean()).map((e) => e.action);

describe('users', () => {
  test('search, paging, role-based email masking, and nothing sensitive in the response', async () => {
    const root = await adminOf(app, 'superadmin');
    const mod = await adminOf(app, 'moderator');
    const u1 = await registerUser(app, { username: 'zebra_one', email: 'zebra1@example.com' });
    await registerUser(app, { username: 'zebra_two', email: 'zebra2@example.com' });
    const full = await root.api.get('/users?q=zebra');
    expect(full.body.data.users.map((u) => u.username).sort()).toEqual(['zebra_one', 'zebra_two']);
    expect(full.body.data.users.map((u) => u.email).sort()).toEqual(['zebra1@example.com', 'zebra2@example.com']);
    const masked = await mod.api.get('/users?q=zebra');
    for (const u of masked.body.data.users) expect(u.email).toMatch(/^z\*\*\*@e\*\*\*\.com$/);
    expect(JSON.stringify([full.body, masked.body])).not.toMatch(/birthDate|passwordHash|resetToken|tokenVersion/);
    expect((await root.api.get('/users?q=zebra1@')).body.data.users).toHaveLength(1);
    expect((await root.api.get(`/users?q=${u1.user.id}`)).body.data.users[0].username).toBe('zebra_one');
    const p1 = await root.api.get('/users?q=zebra&limit=1');
    expect(p1.body.data.users).toHaveLength(1);
    const p2 = await root.api.get(`/users?q=zebra&limit=1&before=${p1.body.data.nextBefore}`);
    expect(p2.body.data.users[0].username).not.toBe(p1.body.data.users[0].username);
    expect((await root.api.get('/users?limit=1000')).status).toBe(400);
    expect((await root.api.get('/users?q=.*')).body.data.users).toHaveLength(0); // regex characters are escaped, not interpreted
  });

  test('suspend signs the person out everywhere and blocks sign-in until reactivated; all of it is audited', async () => {
    const mod = await adminOf(app, 'moderator');
    const u = await registerUser(app);
    expect((await mod.api.post(`/users/${u.user.id}/suspend`, { reason: 'x' })).status).toBe(400); // a real reason is required
    expect((await mod.api.post(`/users/${u.user.id}/suspend`, { reason: 'confirmed harassment reports' })).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', u.cookie)).status).toBe(401);
    const blocked = await consumerLogin(u);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await mod.api.post(`/users/${u.user.id}/suspend`, { reason: 'again please' })).status).toBe(409);
    const detail = await mod.api.get(`/users/${u.user.id}`);
    expect(detail.body.data.status).toBe('suspended');
    expect(detail.body.data.suspension.reason).toBe('confirmed harassment reports');
    expect((await mod.api.post(`/users/${u.user.id}/reactivate`, { reason: 'appeal accepted' })).status).toBe(204);
    expect((await consumerLogin(u)).status).toBe(200);
    expect((await mod.api.post(`/users/${u.user.id}/reactivate`, { reason: 'twice' })).status).toBe(409);
    const log = await AdminAuditLog.find({ targetId: u.user.id }).sort({ seq: 1 }).lean();
    expect(log.map((e) => e.action)).toEqual(['users.suspend', 'users.view', 'users.reactivate']);
    expect(log[0].adminEmail).toBe(mod.email);
    expect(log[0].details.reason).toBe('confirmed harassment reports');
  });
});

describe('rooms: metadata only, never content', () => {
  test('detail shows counts and members but no private content; suspending a room locks it for both partners', async () => {
    const mod = await adminOf(app, 'moderator');
    const c = await makeCouple(app);
    const list = await mod.api.get(`/rooms?q=${c.a.body.username}`);
    expect(list.body.data.rooms).toHaveLength(1);
    const room = list.body.data.rooms[0];
    expect(room.members.map((m) => m.username).sort()).toEqual([c.a.body.username, c.b.body.username].sort());
    const detail = await mod.api.get(`/rooms/${room.id}`);
    expect(Object.keys(detail.body.data.counts).sort()).toEqual(['canvases', 'devices', 'files', 'memories', 'messages', 'pendingInvitations']);
    expect(JSON.stringify(detail.body)).not.toMatch(/ciphertext|nonce|publicKey|passwordHash|birthDate/);

    expect((await mod.api.post(`/rooms/${room.id}/suspend`, { reason: 'child safety escalation' })).status).toBe(204);
    expect((await c.A.get('/api/v1/messages')).status).toBe(404); // the room is unusable for both partners
    expect((await c.B.get('/api/v1/messages')).status).toBe(404);
    expect((await c.A.get('/api/v1/couples/me')).body.data.couple.status).toBe('suspended');
    expect((await mod.api.post(`/rooms/${room.id}/suspend`, { reason: 'twice over' })).status).toBe(409);
    expect((await mod.api.post(`/rooms/${room.id}/reactivate`, { reason: 'cleared after review' })).status).toBe(204);
    expect((await c.A.get('/api/v1/messages')).status).toBe(200);
  });
});

describe('reports and abuse', () => {
  test('a user report reaches the queue, can be reviewed and handled; support can read but not handle', async () => {
    const mod = await adminOf(app, 'moderator');
    const support = await adminOf(app, 'support');
    const c = await makeCouple(app);
    await c.A.post('/api/v1/safety/reports', { category: 'harassment', target: 'partner', details: 'repeated threats', evidence: 'pasted text' });
    const open = await mod.api.get('/reports?status=open');
    const mine = open.body.data.reports.find((r) => r.reporter === c.a.body.username);
    expect(mine.target).toBe(c.b.body.username);
    const detail = await mod.api.get(`/reports/${mine.id}`);
    expect(detail.body.data.details).toBe('repeated threats');
    expect(detail.body.data.evidence).toBe('pasted text');
    expect((await support.api.get(`/reports/${mine.id}`)).status).toBe(200);
    expect((await support.api.post(`/reports/${mine.id}/handle`, { status: 'dismissed' })).status).toBe(403);
    expect((await mod.api.post(`/reports/${mine.id}/handle`, { status: 'bogus' })).status).toBe(400);
    const done = await mod.api.post(`/reports/${mine.id}/handle`, { status: 'actioned', resolution: 'warned the user' });
    expect(done.body.data.status).toBe('actioned');
    expect((await mod.api.get('/reports?status=open')).body.data.reports.find((r) => r.id === mine.id)).toBeUndefined();
    expect(await auditActions()).toEqual(expect.arrayContaining(['reports.view', 'reports.handle']));
  });

  test('heavy inviters are flagged', async () => {
    const mod = await adminOf(app, 'moderator');
    const U = await registerUser(app);
    const A = authed(app, U);
    await A.post('/api/v1/couples', {});
    for (let i = 0; i < 5; i++) {
      const r = await A.post('/api/v1/couples/me/invitations');
      await A.del(`/api/v1/couples/me/invitations/${r.body.data.invitation.id}`);
    }
    const abuse = await mod.api.get('/abuse');
    expect(abuse.body.data.heavyInviters.find((x) => x.username === U.body.username).invitationsLast24h).toBe(5);
  });

  test('overview statistics and alerts have the expected shape', async () => {
    const root = await adminOf(app, 'superadmin');
    await makeCouple(app);
    const s = (await root.api.get('/stats')).body.data;
    expect(s.users.total).toBeGreaterThan(0);
    expect(s.users.byStatus.active).toBeGreaterThan(0);
    expect(s.rooms.connectedCouples).toBeGreaterThan(0);
    expect(s.health.database.ok).toBe(true);
    expect(typeof s.storage.usedBytes).toBe('number');
    expect(s.subscriptions.configured).toBe(false);
    expect(Array.isArray((await root.api.get('/alerts')).body.data.alerts)).toBe(true);
  });
});

describe('platform settings', () => {
  const reset = (root) => root.api.patch('/settings', { appName: 'Our Space', limits: { invitesPerDay: 10 }, features: { canvas: true }, maintenance: { enabled: false } });

  test('validation is strict', async () => {
    const root = await adminOf(app, 'superadmin');
    for (const bad of [{}, { appName: '' }, { theme: { accent: 'pink' } }, { logoUrl: 'http://insecure.example/l.png' }, { limits: { invitesPerDay: 0 } },
      { limits: { invitesPerDay: 101 } }, { limits: { freeStorageBytes: 5 } }, { features: { canvas: 'yes' } }, { features: { teleport: true } }, { surprise: 1 }]) {
      expect((await root.api.patch('/settings', bad)).status).toBe(400);
    }
  });

  test('changes take effect immediately: public config, feature switches and limits; and are audited with before/after', async () => {
    const root = await adminOf(app, 'superadmin');
    const c = await makeCouple(app);
    try {
      expect((await root.api.patch('/settings', { appName: 'Love Nest', limits: { invitesPerDay: 2 }, features: { canvas: false } })).status).toBe(200);
      const pub = await request(app).get('/api/v1/config');
      expect(pub.body.data.appName).toBe('Love Nest');
      expect(pub.body.data.features.canvas).toBe(false);
      expect(pub.body.data).not.toHaveProperty('limits'); // limits are not public
      const off = await c.A.get('/api/v1/canvases');
      expect(off.status).toBe(403);
      expect(off.body.error.code).toBe('FEATURE_DISABLED');

      const U = authed(app, await registerUser(app));
      await U.post('/api/v1/couples', {});
      for (let i = 0; i < 2; i++) { const r = await U.post('/api/v1/couples/me/invitations'); await U.del(`/api/v1/couples/me/invitations/${r.body.data.invitation.id}`); }
      expect((await U.post('/api/v1/couples/me/invitations')).status).toBe(429);

      const entry = (await AdminAuditLog.find({ action: 'settings.update' }).sort({ seq: -1 }).limit(1).lean())[0];
      expect(entry.details.changes.appName).toEqual({ from: 'Our Space', to: 'Love Nest' });
      expect(entry.details.changes['limits.invitesPerDay'].to).toBe(2);
    } finally { await reset(root); }
    expect((await c.A.get('/api/v1/canvases')).status).toBe(200);
  });

  test('maintenance mode answers 503 to the app but never locks admins out', async () => {
    const root = await adminOf(app, 'superadmin');
    const u = await registerUser(app);
    try {
      await root.api.patch('/settings', { maintenance: { enabled: true, message: 'Back in ten minutes' } });
      const r = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`);
      expect(r.status).toBe(503);
      expect(r.body.error).toEqual({ code: 'MAINTENANCE', message: 'Back in ten minutes' });
      expect((await consumerLogin(u)).status).toBe(503);
      expect((await root.api.get('/stats')).status).toBe(200);
      expect((await request(app).get('/api/v1/config')).body.data.maintenance.enabled).toBe(true);
      expect((await signIn(app, root)).res.status).toBe(200);
    } finally { await reset(root); }
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`)).status).toBe(200);
  });
});

describe('audit log', () => {
  test('lists newest first, verifies, detects tampering, and refuses edits through the app', async () => {
    const root = await adminOf(app, 'superadmin');
    const u = await registerUser(app);
    await root.api.get(`/users/${u.user.id}`);
    const list = await root.api.get('/audit?limit=5');
    expect(list.body.data.entries[0].seq).toBeGreaterThan(list.body.data.entries[1].seq);
    const view = (await root.api.get('/audit/verify')).body.data;
    expect(view.ok).toBe(true);
    expect(view.entries).toBeGreaterThan(5);
    expect((await root.api.get('/audit?action=users.view')).body.data.entries.every((e) => e.action === 'users.view')).toBe(true);

    await expect(AdminAuditLog.updateOne({}, { action: 'x' })).rejects.toThrow(/append-only/);
    await expect(AdminAuditLog.deleteMany({})).rejects.toThrow(/append-only/);

    // Someone with direct database access edits an old entry: the chain no longer verifies.
    const victim = await AdminAuditLog.findOne({ action: 'auth.login' }).lean();
    await AdminAuditLog.collection.updateOne({ seq: victim.seq }, { $set: { adminEmail: 'someone.else@evil.test' } });
    const bad = (await root.api.get('/audit/verify')).body.data;
    expect(bad).toMatchObject({ ok: false, brokenAtSeq: victim.seq, reason: 'entry content was altered' });
    await AdminAuditLog.collection.updateOne({ seq: victim.seq }, { $set: { adminEmail: victim.adminEmail } });
    expect((await root.api.get('/audit/verify')).body.data.ok).toBe(true);
  });
});

describe('managing admin accounts', () => {
  test('disable, role change and MFA reset take effect immediately; you cannot do them to yourself; only superadmins can', async () => {
    const root = await adminOf(app, 'superadmin');
    const target = await adminOf(app, 'moderator');
    expect((await root.api.post(`/admins/${root.admin.id}/disable`, {})).status).toBe(400);
    expect((await root.api.post(`/admins/${root.admin.id}/role`, { role: 'support' })).status).toBe(400);
    expect((await target.api.post('/admins', { email: 'x@company.test', role: 'support' })).status).toBe(403);

    expect((await root.api.post(`/admins/${target.admin.id}/role`, { role: 'support' })).body.data.role).toBe('support');
    expect((await target.api.get('/users')).status).toBe(401); // old token dies with the role change
    const again = await signIn(app, target);
    expect((await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${again.token}`)).body.data.admin.role).toBe('support');

    expect((await root.api.post(`/admins/${target.admin.id}/disable`, {})).body.data.status).toBe('disabled');
    expect((await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${again.token}`)).status).toBe(401);
    expect((await login(app, target.email)).status).toBe(401);
    expect((await root.api.post(`/admins/${target.admin.id}/enable`, {})).body.data.status).toBe('active');
    expect((await root.api.post(`/admins/${target.admin.id}/enable`, {})).status).toBe(400); // already active

    expect((await root.api.post(`/admins/${target.admin.id}/reset-mfa`, {})).status).toBe(200);
    const l = await login(app, target.email);
    expect(l.body.data.stage).toBe('enroll'); // must register an authenticator again
    expect(await auditActions()).toEqual(expect.arrayContaining(['admins.set_role', 'admins.disable', 'admins.enable', 'admins.reset-mfa']));
  });
});
