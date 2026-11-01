const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDb } = require('../src/config/db');

let mongod;
let n = 0;
const PASSWORD = 'Str0ng!Passw0rd';

require('../src/models/User');
require('../src/models/Couple');
require('../src/models/Invitation');
require('../src/models/RefreshToken');
require('../src/models/Device');
require('../src/models/RoomKeyEnvelope');
require('../src/models/Message');
require('../src/models/RecoveryBlob');
require('../src/models/Canvas');
require('../src/models/CanvasOp');
require('../src/models/MediaAsset');
require('../src/models/Memory');
require('../src/models/Album');
require('../src/models/Block');
require('../src/models/Report');

// Use TEST_MONGODB_URI (e.g. mongodb://127.0.0.1:27017) to test against a real local MongoDB instead of
// downloading an in-memory binary. Each test file gets its own random database, dropped afterwards.
// NEVER point this at a database that holds real data.
const EXTERNAL = process.env.TEST_MONGODB_URI;
async function startDb() {
  if (EXTERNAL) {
    await connectDb(EXTERNAL, { dbName: `couples_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}` });
    return;
  }
  mongod = await MongoMemoryServer.create();
  await connectDb(mongod.getUri());
}
async function stopDb() {
  if (EXTERNAL && mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}
const cookieOf = (res) => res.headers['set-cookie'][0].split(';')[0];

async function registerUser(app, overrides = {}) {
  n += 1;
  const body = { username: `user${n}`, email: `user${n}@example.com`, password: PASSWORD, birthDate: '1995-05-05', ...overrides };
  const res = await request(app).post('/api/v1/auth/register').send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { body, token: res.body.data.accessToken, user: res.body.data.user, cookie: cookieOf(res) };
}
const authed = (app, u) => ({
  get: (p) => request(app).get(p).set('Authorization', `Bearer ${u.token}`),
  post: (p, b) => request(app).post(p).set('Authorization', `Bearer ${u.token}`).send(b),
  put: (p, b) => request(app).put(p).set('Authorization', `Bearer ${u.token}`).send(b),
  patch: (p, b) => request(app).patch(p).set('Authorization', `Bearer ${u.token}`).send(b),
  del: (p) => request(app).delete(p).set('Authorization', `Bearer ${u.token}`),
});

// Creates two users and links them as an active couple through the real HTTP flow.
async function makeCouple(app) {
  const a = await registerUser(app);
  const b = await registerUser(app);
  const A = authed(app, a);
  const B = authed(app, b);
  await A.post('/api/v1/couples', { name: 'Us' });
  const inv = await A.post('/api/v1/couples/me/invitations');
  await B.post('/api/v1/invitations/accept', { code: inv.body.data.code });
  await A.post(`/api/v1/couples/me/invitations/${inv.body.data.invitation.id}/confirm`);
  return { a, b, A, B };
}
module.exports = { startDb, stopDb, registerUser, authed, makeCouple, cookieOf, PASSWORD };
