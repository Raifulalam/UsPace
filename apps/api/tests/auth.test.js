const request = require('supertest');
const { createApp } = require('../src/app');
const { startDb, stopDb, registerUser, cookieOf, PASSWORD } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

describe('registration', () => {
  test('creates a user, returns an access token and an httpOnly refresh cookie, no secrets', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      username: 'Alice', email: 'Alice@Example.com', password: PASSWORD, birthDate: '1990-01-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.username).toBe('alice');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|birthDate/);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });
  test('rejects under-age users', async () => {
    const year = new Date().getUTCFullYear() - 16;
    const res = await request(app).post('/api/v1/auth/register').send({
      username: 'kid', email: 'kid@example.com', password: PASSWORD, birthDate: `${year}-01-01`,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNDERAGE');
  });
  test('rejects duplicates, weak passwords and role injection', async () => {
    const u = await registerUser(app);
    const dup = await request(app).post('/api/v1/auth/register').send({ ...u.body });
    expect(dup.status).toBe(409);
    const weak = await request(app).post('/api/v1/auth/register').send({ ...u.body, username: 'weakone', email: 'w@e.com', password: 'short' });
    expect(weak.status).toBe(400);
    const inject = await request(app).post('/api/v1/auth/register').send({ ...u.body, username: 'evil', email: 'e@e.com', role: 'superadmin' });
    expect(inject.status).toBe(400);
  });
});

describe('login', () => {
  test('succeeds with username or email; fails generically otherwise', async () => {
    const u = await registerUser(app);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password: PASSWORD })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: u.body.email, password: PASSWORD })).status).toBe(200);
    const bad = await request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password: 'wrong-password' });
    const none = await request(app).post('/api/v1/auth/login').send({ identifier: 'nobody', password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toEqual(none.body.error);
  });
  test('blocks NoSQL operator injection', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ identifier: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
  });
  test('locks the account after 5 failures, even for the right password', async () => {
    const u = await registerUser(app);
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password: 'wrong-password' });
    }
    const res = await request(app).post('/api/v1/auth/login').send({ identifier: u.body.username, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('sessions', () => {
  test('/me requires a valid token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer nope')).status).toBe(401);
    const u = await registerUser(app);
    const ok = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(ok.body.data.user.username).toBe(u.body.username);
  });
  test('refresh rotates tokens; replaying an old one revokes the whole family', async () => {
    const u = await registerUser(app);
    const first = await request(app).post('/api/v1/auth/refresh').set('Cookie', u.cookie);
    expect(first.status).toBe(200);
    const newer = cookieOf(first);
    expect(newer).not.toBe(u.cookie);

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', u.cookie);
    expect(replay.status).toBe(401);
    const afterTheft = await request(app).post('/api/v1/auth/refresh').set('Cookie', newer);
    expect(afterTheft.status).toBe(401);
  });
  test('logout revokes the refresh token', async () => {
    const u = await registerUser(app);
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', u.cookie)).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', u.cookie)).status).toBe(401);
  });
});
