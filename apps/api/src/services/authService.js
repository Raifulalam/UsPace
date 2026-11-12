const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const config = require('../config/env');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const AppError = require('../utils/AppError');
const { sha256, randomToken } = require('../utils/crypto');
const { signAccessToken } = require('../utils/tokens');
const { sendVerificationEmail } = require('./mailer');

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
// Used so unknown-user logins cost the same as real ones (timing side channel).
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', config.BCRYPT_COST);

function ageOn(birth, now = new Date()) {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

async function issueSession(user, ctx, familyId = crypto.randomUUID(), sharedSession = false) {
  const refreshToken = randomToken(48);
  await RefreshToken.create({
    userId: user._id,
    familyId,
    tokenHash: sha256(refreshToken),
    sharedSession,
    expiresAt: new Date(Date.now() + (sharedSession
      ? config.SHARED_REFRESH_TOKEN_TTL_DAYS
      : config.REFRESH_TOKEN_TTL_DAYS) * 86400000),
    userAgent: ctx.userAgent,
    ip: ctx.ip,
  });
  return { accessToken: signAccessToken(user), refreshToken, persistent: sharedSession };
}

async function register(input, ctx) {
  const birth = new Date(`${input.birthDate}T00:00:00Z`);
  if (Number.isNaN(birth.getTime()) || ageOn(birth) < config.MIN_AGE) {
    throw new AppError(403, 'UNDERAGE', `You must be at least ${config.MIN_AGE} to use this app`);
  }
  const verifyToken = randomToken(32);
  let user;
  try {
    user = await User.create({
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      birthDate: birth,
      passwordHash: await bcrypt.hash(input.password, config.BCRYPT_COST),
      emailVerifyTokenHash: sha256(verifyToken),
      emailVerifyExpiresAt: new Date(Date.now() + 24 * 3600000),
      ...(input.termsAccepted && input.privacyAccepted ? { termsAcceptedAt: new Date(), privacyAcceptedAt: new Date() } : {}),
    });
  } catch (e) {
    if (e.code === 11000) {
      const field = Object.keys(e.keyPattern || {})[0] || 'account';
      throw new AppError(409, 'ALREADY_EXISTS', `That ${field} is already taken`);
    }
    throw e;
  }
  await sendVerificationEmail(user.email, verifyToken);
  return { user, session: await issueSession(user, ctx, crypto.randomUUID(), ctx.sharedSession === true) };
}

async function login({ identifier, password }, ctx) {
  const id = identifier.toLowerCase().trim();
  const user = await User.findOne({ $or: [{ email: id }, { username: id }] }).select('+passwordHash');
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username/email or password');
  }
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginCount: 1 } }, { new: true });
    if (updated.failedLoginCount >= MAX_FAILED) {
      await User.updateOne({ _id: user._id }, { $set: { lockUntil: new Date(Date.now() + LOCK_MS), failedLoginCount: 0 } });
    }
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username/email or password');
  }
  if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Account is not active');
  const now = new Date();
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        failedLoginCount: 0,
        lastLoginAt: now,
        ...(user.termsAcceptedAt ? {} : { termsAcceptedAt: now }),
        ...(user.privacyAcceptedAt ? {} : { privacyAcceptedAt: now }),
      },
      $unset: { lockUntil: 1 },
    }
  );
  return { user, session: await issueSession(user, ctx, crypto.randomUUID(), ctx.sharedSession === true) };
}

// Normal refresh tokens rotate with reuse detection. Shared Android/WebView sessions keep
// one refresh token so both surfaces can refresh the same login without racing each other.
async function refresh(rawToken, ctx) {
  if (!rawToken) throw new AppError(401, 'UNAUTHENTICATED', 'No refresh token');
  const tokenHash = sha256(rawToken);
  const rec = await RefreshToken.findOne({ tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!rec) {
    const old = await RefreshToken.findOne({ tokenHash });
    if (old) await RefreshToken.updateMany({ familyId: old.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw new AppError(401, 'INVALID_REFRESH', 'Session expired, please log in again');
  }
  const user = await User.findById(rec.userId);
  if (!user || user.status !== 'active') throw new AppError(401, 'INVALID_REFRESH', 'Session expired, please log in again');
  if (rec.sharedSession) {
    return { user, session: { accessToken: signAccessToken(user), refreshToken: rawToken, persistent: true } };
  }
  const consumed = await RefreshToken.findOneAndUpdate(
    { _id: rec._id, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } }
  );
  if (!consumed) {
    await RefreshToken.updateMany({ familyId: rec.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw new AppError(401, 'INVALID_REFRESH', 'Session expired, please log in again');
  }
  return { user, session: await issueSession(user, ctx, rec.familyId) };
}

async function logout(rawToken) {
  if (!rawToken) return;
  const rec = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  if (rec) await RefreshToken.updateMany({ familyId: rec.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

async function verifyEmail(token) {
  const u = await User.findOneAndUpdate(
    { emailVerifyTokenHash: sha256(token), emailVerifyExpiresAt: { $gt: new Date() } },
    { $set: { emailVerifiedAt: new Date() }, $unset: { emailVerifyTokenHash: 1, emailVerifyExpiresAt: 1 } },
    { new: true }
  );
  if (!u) throw new AppError(400, 'INVALID_VERIFICATION', 'Verification link is invalid or expired');
  return u;
}

module.exports = { register, login, refresh, logout, verifyEmail, ageOn };
