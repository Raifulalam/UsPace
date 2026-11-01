const bcrypt = require('bcryptjs');
const config = require('../config/env');
const User = require('../models/User');
const Device = require('../models/Device');
const RefreshToken = require('../models/RefreshToken');
const Couple = require('../models/Couple');
const Invitation = require('../models/Invitation');
const Message = require('../models/Message');
const Memory = require('../models/Memory');
const CanvasOp = require('../models/CanvasOp');
const MediaAsset = require('../models/MediaAsset');
const Block = require('../models/Block');
const Report = require('../models/Report');
const AppError = require('../utils/AppError');
const { sha256, randomToken } = require('../utils/crypto');
const { signAccessToken } = require('../utils/tokens');
const { maskIp, describeAgent, deletionDate } = require('../utils/privacy');
const { sendPasswordResetEmail } = require('./mailer');
const coupleService = require('./coupleService');

const now = () => new Date();
const revokeAll = (userId, except) =>
  RefreshToken.updateMany({ userId, revokedAt: null, ...(except ? { familyId: { $ne: except } } : {}) }, { $set: { revokedAt: now() } });

// 403 (not 401) on purpose: the web client treats 401 as "access token expired" and would try to refresh and retry.
async function verifyPassword(userId, plain) {
  const u = await User.findById(userId).select('+passwordHash');
  if (!u || !(await bcrypt.compare(plain, u.passwordHash))) throw new AppError(403, 'INVALID_PASSWORD', 'That password is not correct');
  return u;
}
async function currentFamily(rawToken) {
  if (!rawToken) return null;
  const rec = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  return rec ? rec.familyId : null;
}

// ---------- password reset ----------
// Always succeeds from the caller's point of view, so it cannot be used to discover which emails have accounts.
// Resetting a password does NOT touch end-to-end encryption keys: those live on your devices.
async function requestPasswordReset(email) {
  const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+resetRequestedAt');
  if (!user || user.status === 'suspended') return;
  if (user.resetRequestedAt && Date.now() - user.resetRequestedAt.getTime() < 60000) return; // at most one email per minute
  const token = randomToken(32);
  await User.updateOne({ _id: user._id }, { $set: { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + 3600000), resetRequestedAt: now() } });
  await sendPasswordResetEmail(user.email, token);
}

async function confirmPasswordReset(token, newPassword) {
  const user = await User.findOneAndUpdate(
    { resetTokenHash: sha256(token), resetExpiresAt: { $gt: now() } },
    {
      $set: { passwordHash: await bcrypt.hash(newPassword, config.BCRYPT_COST), failedLoginCount: 0 },
      $inc: { tokenVersion: 1 },
      $unset: { resetTokenHash: 1, resetExpiresAt: 1, lockUntil: 1 },
    },
    { new: true }
  );
  if (!user) throw new AppError(400, 'INVALID_RESET', 'This reset link is invalid or has expired');
  await revokeAll(user._id); // every device must sign in again with the new password
}

async function changePassword(user, currentPassword, newPassword, rawRefresh) {
  await verifyPassword(user._id, currentPassword);
  const family = await currentFamily(rawRefresh);
  const updated = await User.findByIdAndUpdate(user._id, { $set: { passwordHash: await bcrypt.hash(newPassword, config.BCRYPT_COST) }, $inc: { tokenVersion: 1 } }, { new: true });
  await revokeAll(user._id, family); // other devices are signed out; this one keeps its session
  return signAccessToken(updated);
}

// ---------- sessions ----------
async function listSessions(user, rawRefresh) {
  const mine = rawRefresh ? sha256(rawRefresh) : null;
  // Refresh tokens rotate and old ones are revoked, so each live record is exactly one active session.
  const rows = await RefreshToken.find({ userId: user._id, revokedAt: null, expiresAt: { $gt: now() } }).sort({ updatedAt: -1 });
  return rows.map((r) => ({ id: r.familyId, device: describeAgent(r.userAgent), network: maskIp(r.ip), lastActive: r.createdAt, current: r.tokenHash === mine }));
}
async function revokeSession(user, familyId) {
  const r = await RefreshToken.updateMany({ userId: user._id, familyId, revokedAt: null }, { $set: { revokedAt: now() } });
  if (r.modifiedCount === 0) throw new AppError(404, 'SESSION_NOT_FOUND', 'No such session');
}
async function logoutEverywhere(user) {
  await revokeAll(user._id);
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } }); // also kills access tokens that are still valid for minutes
}

// ---------- account deletion (14-day grace, then the retention job erases everything) ----------
async function requestDeletion(user, password) {
  await verifyPassword(user._id, password);
  if (user.coupleId) await coupleService.leaveCouple(user).catch(() => {}); // ends the relationship; the room's content is then purged on schedule
  const scheduled = deletionDate();
  await User.updateOne({ _id: user._id }, { $set: { status: 'pending_deletion', deletionRequestedAt: now(), deletionScheduledAt: scheduled }, $inc: { tokenVersion: 1 } });
  await revokeAll(user._id);
  return scheduled;
}
async function cancelDeletion(identifier, password) {
  const id = String(identifier).toLowerCase().trim();
  const user = await User.findOne({ $or: [{ email: id }, { username: id }], status: 'pending_deletion', deletionScheduledAt: { $gt: now() } }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new AppError(403, 'INVALID_CREDENTIALS', 'Could not cancel deletion with those details');
  await User.updateOne({ _id: user._id }, { $set: { status: 'active' }, $unset: { deletionRequestedAt: 1, deletionScheduledAt: 1 } });
}

// ---------- data export ----------
// Contents of messages, memories and drawings are end-to-end encrypted, so the server can only export what it holds in the clear.
async function exportData(user, rawRefresh) {
  const full = await User.findById(user._id).select('+birthDate');
  const [devices, sessions, couple, blocks, reports, sent, ops, memories, assets, invitations] = await Promise.all([
    Device.find({ userId: user._id }),
    listSessions(user, rawRefresh),
    user.coupleId ? Couple.findOne({ _id: user.coupleId, members: user._id }) : null,
    Block.find({ blockerId: user._id }).populate('blockedId', 'username'),
    Report.find({ reporterId: user._id }).select('category createdAt status'),
    Message.countDocuments({ senderId: user._id }),
    CanvasOp.countDocuments({ senderId: user._id }),
    Memory.countDocuments({ createdBy: user._id, deletedAt: null }),
    MediaAsset.find({ uploaderId: user._id, status: { $ne: 'deleted' } }).select('sizeBytes'),
    Invitation.countDocuments({ $or: [{ inviterId: user._id }, { inviteeId: user._id }] }),
  ]);
  return {
    exportedAt: now().toISOString(),
    account: { username: full.username, email: full.email, displayName: full.displayName ?? null, birthDate: full.birthDate?.toISOString().slice(0, 10), createdAt: full.createdAt, emailVerified: Boolean(full.emailVerifiedAt), status: full.status },
    devices: devices.map((d) => ({ id: d.id, label: d.label, publicKey: d.publicKey, createdAt: d.createdAt, revokedAt: d.revokedAt ?? null })),
    sessions,
    couple: couple ? { id: couple.id, status: couple.status, name: couple.name, theme: couple.theme, anniversaryDate: couple.anniversaryDate ?? null, createdAt: couple.createdAt, storageUsedBytes: couple.storageUsed } : null,
    counts: { messagesSent: sent, drawingActionsMade: ops, memoriesCreated: memories, filesUploaded: assets.length, bytesUploaded: assets.reduce((n, a) => n + a.sizeBytes, 0), invitations },
    blockedUsers: blocks.map((b) => b.blockedId?.username).filter(Boolean),
    reportsFiled: reports.map((r) => ({ category: r.category, status: r.status, createdAt: r.createdAt })),
    note: 'Your messages, memories, drawings and files are end-to-end encrypted. We cannot read them, so they are not in this file. Export them from the app on a device that holds your keys.',
  };
}

module.exports = {
  requestPasswordReset, confirmPasswordReset, changePassword, listSessions, revokeSession, logoutEverywhere,
  requestDeletion, cancelDeletion, exportData, currentFamily,
};
