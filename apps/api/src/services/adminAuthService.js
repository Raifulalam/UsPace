const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config/env');
const AdminAccount = require('../models/AdminAccount');
const AdminSession = require('../models/AdminSession');
const AppError = require('../utils/AppError');
const { sha256, randomToken } = require('../utils/crypto');
const { seal, open } = require('../admin/secretBox');
const T = require('../admin/totp');
const audit = require('./adminAuditService');

const PREAUTH_TTL = '5m';
const ACCESS_TTL = '10m';
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 8 * 3600 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const ISSUER = 'Our Space Admin';
const DUMMY = bcrypt.hashSync('timing-equalizer-admin', config.BCRYPT_COST);

function ensureConfigured() {
  if (!config.ADMIN_JWT_SECRET || !config.ADMIN_MFA_KEY) throw new AppError(503, 'ADMIN_DISABLED', 'The admin area is not configured on this server');
}
const sign = (payload, aud, exp) => jwt.sign(payload, config.ADMIN_JWT_SECRET, { algorithm: 'HS256', audience: aud, expiresIn: exp });
const verifyJwt = (token, aud) => jwt.verify(token, config.ADMIN_JWT_SECRET, { algorithms: ['HS256'], audience: aud });
const invalid = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
const adminView = (a) => ({ id: a.id, email: a.email, role: a.role, status: a.status, mfaEnabled: a.mfaEnabled, lastLoginAt: a.lastLoginAt ?? null, createdAt: a.createdAt });

async function recordFailure(admin, ctx, step) {
  const u = await AdminAccount.findByIdAndUpdate(admin._id, { $inc: { failedLogins: 1 } }, { new: true });
  await audit.record({ admin, action: 'auth.login_failed', details: { step }, ip: ctx.ip });
  if (u.failedLogins >= MAX_FAILS) {
    await AdminAccount.updateOne({ _id: admin._id }, { $set: { lockUntil: new Date(Date.now() + LOCK_MS), failedLogins: 0 } });
    await audit.record({ admin, action: 'auth.locked', details: { minutes: LOCK_MS / 60000 }, ip: ctx.ip });
  }
}
const assertNotLocked = (admin) => {
  if (admin.lockUntil && admin.lockUntil > new Date()) throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
};

/** Next step after the password is accepted: enter an authenticator code, or enrol one first. */
async function nextStage(admin) {
  const base = { sub: admin.id, tv: admin.tokenVersion };
  if (admin.mfaEnabled) return { stage: 'mfa', preAuthToken: sign({ ...base, stage: 'mfa' }, 'admin-preauth', PREAUTH_TTL) };
  let secret;
  const withPending = admin.mfaPendingEnc ? admin : await AdminAccount.findById(admin._id).select('+mfaPendingEnc');
  if (withPending.mfaPendingEnc) secret = open(withPending.mfaPendingEnc, config.ADMIN_MFA_KEY);
  else { secret = T.generateSecret(); await AdminAccount.updateOne({ _id: admin._id }, { $set: { mfaPendingEnc: seal(secret, config.ADMIN_MFA_KEY) } }); }
  return { stage: 'enroll', preAuthToken: sign({ ...base, stage: 'enroll' }, 'admin-preauth', PREAUTH_TTL), secret, otpauthUri: T.otpauthUri({ secret, account: admin.email, issuer: ISSUER }) };
}

async function login(email, password, ctx) {
  ensureConfigured();
  const lower = String(email).toLowerCase().trim();
  const admin = await AdminAccount.findOne({ email: lower }).select('+passwordHash +mfaPendingEnc');
  if (!admin || admin.status !== 'active' || !admin.passwordHash) {
    await bcrypt.compare(password, DUMMY); // same cost whether or not the account exists
    await audit.record({ email: lower, action: 'auth.login_failed', details: { reason: !admin ? 'unknown account' : `account ${admin.status}` }, ip: ctx.ip });
    throw invalid();
  }
  assertNotLocked(admin);
  if (!(await bcrypt.compare(password, admin.passwordHash))) { await recordFailure(admin, ctx, 'password'); throw invalid(); }
  return nextStage(admin);
}

async function loadPreAuth(token, stage) {
  ensureConfigured();
  let p;
  try { p = verifyJwt(token, 'admin-preauth'); } catch { throw new AppError(401, 'INVALID_PREAUTH', 'Please sign in again'); }
  if (p.stage !== stage) throw new AppError(401, 'INVALID_PREAUTH', 'Please sign in again');
  const admin = await AdminAccount.findById(p.sub).select('+mfaSecretEnc +mfaPendingEnc +recoveryHashes');
  if (!admin || admin.status !== 'active' || admin.tokenVersion !== p.tv) throw new AppError(401, 'INVALID_PREAUTH', 'Please sign in again');
  assertNotLocked(admin);
  return admin;
}

async function createSession(admin, ctx, familyId = crypto.randomUUID(), familyStartedAt = new Date()) {
  const refreshToken = randomToken(48);
  await AdminSession.create({
    adminId: admin._id, familyId, tokenHash: sha256(refreshToken), familyStartedAt,
    expiresAt: new Date(Math.min(Date.now() + IDLE_MS, familyStartedAt.getTime() + ABSOLUTE_MS)), ip: ctx.ip, userAgent: ctx.userAgent,
  });
  return { accessToken: sign({ sub: admin.id, role: admin.role, tv: admin.tokenVersion }, 'admin', ACCESS_TTL), refreshToken };
}

async function finishLogin(admin, ctx, extra = {}) {
  if (admin.lastLoginIp && ctx.ip && admin.lastLoginIp !== ctx.ip) await audit.record({ admin, action: 'auth.new_ip', details: { previous: admin.lastLoginIp }, ip: ctx.ip });
  await AdminAccount.updateOne({ _id: admin._id }, { $set: { failedLogins: 0, lastLoginAt: new Date(), lastLoginIp: ctx.ip }, $unset: { lockUntil: 1 } });
  await audit.record({ admin, action: 'auth.login', ip: ctx.ip });
  return { admin: adminView(admin), session: await createSession(admin, ctx), ...extra };
}

async function verifyMfa(preAuthToken, code, ctx) {
  const admin = await loadPreAuth(preAuthToken, 'mfa');
  const raw = String(code).trim();
  let used = false;
  const step = T.verifyTotp(open(admin.mfaSecretEnc, config.ADMIN_MFA_KEY), raw, { lastUsedStep: admin.mfaLastStep });
  if (step !== null) {
    // Atomic: two requests with the same code cannot both succeed (replay protection).
    used = (await AdminAccount.updateOne({ _id: admin._id, mfaLastStep: { $lt: step } }, { $set: { mfaLastStep: step } })).modifiedCount === 1;
  } else if (/^[A-Za-z2-7]{4}-?[A-Za-z2-7]{4}$/.test(raw)) {
    const h = T.hashRecovery(raw);
    used = (await AdminAccount.updateOne({ _id: admin._id, recoveryHashes: h }, { $pull: { recoveryHashes: h } })).modifiedCount === 1;
    if (used) await audit.record({ admin, action: 'auth.recovery_code_used', ip: ctx.ip });
  }
  if (!used) { await recordFailure(admin, ctx, 'mfa'); throw new AppError(401, 'INVALID_CODE', 'That code is not correct'); }
  return finishLogin(admin, ctx);
}

async function enrollMfa(preAuthToken, code, ctx) {
  const admin = await loadPreAuth(preAuthToken, 'enroll');
  if (!admin.mfaPendingEnc) throw new AppError(401, 'INVALID_PREAUTH', 'Please sign in again');
  const secret = open(admin.mfaPendingEnc, config.ADMIN_MFA_KEY);
  const step = T.verifyTotp(secret, String(code).trim());
  if (step === null) { await recordFailure(admin, ctx, 'enroll'); throw new AppError(401, 'INVALID_CODE', 'That code is not correct. Check the time on your phone.'); }
  const recoveryCodes = T.generateRecoveryCodes();
  await AdminAccount.updateOne({ _id: admin._id }, {
    $set: { mfaEnabled: true, mfaSecretEnc: seal(secret, config.ADMIN_MFA_KEY), mfaLastStep: step, recoveryHashes: recoveryCodes.map(T.hashRecovery) },
    $unset: { mfaPendingEnc: 1 },
  });
  await audit.record({ admin, action: 'auth.mfa_enrolled', ip: ctx.ip });
  const fresh = await AdminAccount.findById(admin._id);
  return finishLogin(fresh, ctx, { recoveryCodes }); // shown once, never retrievable again
}

/** An invited admin sets a password using the one-time link a superadmin gave them. */
async function setup(token, password, ctx) {
  ensureConfigured();
  const admin = await AdminAccount.findOneAndUpdate(
    { setupTokenHash: sha256(token), setupExpiresAt: { $gt: new Date() }, status: 'invited' },
    { $set: { passwordHash: await bcrypt.hash(password, config.BCRYPT_COST), status: 'active' }, $unset: { setupTokenHash: 1, setupExpiresAt: 1 } },
    { new: true }
  );
  if (!admin) throw new AppError(400, 'INVALID_SETUP', 'This setup link is invalid or has expired');
  await audit.record({ admin, action: 'auth.setup', ip: ctx.ip });
  return nextStage(admin);
}

/** Rotating refresh with reuse detection. Idle for 30 minutes, or 8 hours after sign-in, ends the session. */
async function refresh(raw, ctx) {
  ensureConfigured();
  if (!raw) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  const tokenHash = sha256(raw);
  const rec = await AdminSession.findOneAndUpdate({ tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } }, { $set: { revokedAt: new Date() } });
  if (!rec) {
    const old = await AdminSession.findOne({ tokenHash });
    if (old) {
      await AdminSession.updateMany({ familyId: old.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      await audit.record({ admin: { _id: old.adminId, email: null }, action: 'auth.refresh_reuse', details: { familyId: old.familyId }, ip: ctx.ip });
    }
    throw new AppError(401, 'SESSION_ENDED', 'Please sign in again');
  }
  const admin = await AdminAccount.findById(rec.adminId);
  if (!admin || admin.status !== 'active' || !admin.mfaEnabled || Date.now() - rec.familyStartedAt.getTime() >= ABSOLUTE_MS) throw new AppError(401, 'SESSION_ENDED', 'Please sign in again');
  return { admin: adminView(admin), session: await createSession(admin, ctx, rec.familyId, rec.familyStartedAt) };
}

async function logout(raw) {
  if (!raw) return;
  const rec = await AdminSession.findOne({ tokenHash: sha256(raw) });
  if (rec) await AdminSession.updateMany({ familyId: rec.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function authenticate(accessToken) {
  ensureConfigured();
  if (!accessToken) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  let p;
  try { p = verifyJwt(accessToken, 'admin'); } catch { throw new AppError(401, 'INVALID_TOKEN', 'Please sign in again'); }
  const admin = await AdminAccount.findById(p.sub);
  if (!admin || admin.status !== 'active' || !admin.mfaEnabled || admin.tokenVersion !== p.tv) throw new AppError(401, 'INVALID_TOKEN', 'Please sign in again');
  return admin;
}

// ---------- managing admin accounts (superadmin only; enforced by the route permission) ----------
const revokeAllSessions = (adminId) => AdminSession.updateMany({ adminId, revokedAt: null }, { $set: { revokedAt: new Date() } });

async function inviteAdmin(by, email, role, ctx) {
  const token = randomToken(32);
  let admin;
  try {
    admin = await AdminAccount.create({ email, role, status: 'invited', setupTokenHash: sha256(token), setupExpiresAt: new Date(Date.now() + 48 * 3600000), createdBy: by?._id });
  } catch (e) {
    if (e.code === 11000) throw new AppError(409, 'ALREADY_EXISTS', 'An admin with that email already exists');
    throw e;
  }
  await audit.record({ admin: by, action: 'admins.invite', targetType: 'admin', targetId: admin.id, details: { email, role }, ip: ctx.ip });
  return { admin: adminView(admin), setupToken: token, setupUrl: `${config.ADMIN_ORIGIN}/?setup=${token}` };
}
async function listAdmins() {
  return (await AdminAccount.find().sort({ createdAt: 1 })).map(adminView);
}
async function changeAdmin(by, id, action, ctx) {
  if (String(by._id) === String(id)) throw new AppError(400, 'SELF_ACTION', 'You cannot do this to your own account');
  const target = await AdminAccount.findById(id);
  if (!target) throw new AppError(404, 'NOT_FOUND', 'No such admin');
  const updates = {
    disable: { $set: { status: 'disabled' }, $inc: { tokenVersion: 1 } },
    enable: target.status === 'disabled' ? { $set: { status: 'active' } } : null, // only a disabled admin can be re-enabled
    'reset-mfa': { $set: { mfaEnabled: false }, $unset: { mfaSecretEnc: 1, mfaPendingEnc: 1, recoveryHashes: 1 }, $inc: { tokenVersion: 1 } },
  };
  const u = updates[action];
  if (!u) throw new AppError(400, 'BAD_ACTION', 'Unknown action');
  await AdminAccount.updateOne({ _id: id }, u);
  if (action !== 'enable') await revokeAllSessions(id);
  await audit.record({ admin: by, action: `admins.${action}`, targetType: 'admin', targetId: id, details: { email: target.email }, ip: ctx.ip });
  return adminView(await AdminAccount.findById(id));
}
async function setRole(by, id, role, ctx) {
  if (String(by._id) === String(id)) throw new AppError(400, 'SELF_ACTION', 'You cannot change your own role');
  const target = await AdminAccount.findByIdAndUpdate(id, { $set: { role }, $inc: { tokenVersion: 1 } }, { new: true });
  if (!target) throw new AppError(404, 'NOT_FOUND', 'No such admin');
  await revokeAllSessions(id);
  await audit.record({ admin: by, action: 'admins.set_role', targetType: 'admin', targetId: id, details: { email: target.email, role }, ip: ctx.ip });
  return adminView(target);
}

module.exports = {
  ensureConfigured, login, verifyMfa, enrollMfa, setup, refresh, logout, authenticate, inviteAdmin, listAdmins, changeAdmin, setRole, adminView,
};
