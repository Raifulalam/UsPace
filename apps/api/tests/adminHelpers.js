const request = require('supertest');
const bcrypt = require('bcryptjs');
const AdminAccount = require('../src/models/AdminAccount');
const { seal } = require('../src/admin/secretBox');
const T = require('../src/admin/totp');

const PASS = 'Adm1n!Passw0rd-long';
let n = 0;

// Creates a ready-to-use admin (password + authenticator already set up) directly in the database.
async function makeAdmin(role = 'superadmin', over = {}) {
  n += 1;
  const secret = T.generateSecret();
  const admin = await AdminAccount.create({
    email: `admin${n}-${Date.now()}@company.test`, role, status: 'active', passwordHash: await bcrypt.hash(PASS, 4),
    mfaEnabled: true, mfaSecretEnc: seal(secret, process.env.ADMIN_MFA_KEY), ...over,
  });
  return { admin, secret, email: admin.email };
}
const login = (app, email, password = PASS) => request(app).post('/api/v1/admin/auth/login').send({ email, password });
const mfa = (app, preAuthToken, code) => request(app).post('/api/v1/admin/auth/mfa').send({ preAuthToken, code });

// Full sign-in with a fresh authenticator code. Resets the replay guard first so tests can sign in repeatedly.
async function signIn(app, a) {
  await AdminAccount.updateOne({ _id: a.admin._id }, { mfaLastStep: 0 });
  const l = await login(app, a.email);
  const m = await mfa(app, l.body.data.preAuthToken, T.totp(a.secret));
  if (m.status !== 200) throw new Error(`admin sign-in failed: ${m.status} ${JSON.stringify(m.body)}`);
  return { token: m.body.data.accessToken, cookie: m.headers['set-cookie'][0].split(';')[0], res: m };
}
const client = (app, token) => ({
  get: (p) => request(app).get(`/api/v1/admin${p}`).set('Authorization', `Bearer ${token}`),
  post: (p, b) => request(app).post(`/api/v1/admin${p}`).set('Authorization', `Bearer ${token}`).send(b),
  patch: (p, b) => request(app).patch(`/api/v1/admin${p}`).set('Authorization', `Bearer ${token}`).send(b),
});
async function adminOf(app, role = 'superadmin') {
  const a = await makeAdmin(role);
  const s = await signIn(app, a);
  return { ...a, token: s.token, cookie: s.cookie, api: client(app, s.token) };
}
module.exports = { PASS, makeAdmin, login, mfa, signIn, client, adminOf, T };
