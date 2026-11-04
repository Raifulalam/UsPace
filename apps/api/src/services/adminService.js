const mongoose = require('mongoose');
const User = require('../models/User');
const Couple = require('../models/Couple');
const Device = require('../models/Device');
const RefreshToken = require('../models/RefreshToken');
const Invitation = require('../models/Invitation');
const Message = require('../models/Message');
const Canvas = require('../models/Canvas');
const Memory = require('../models/Memory');
const MediaAsset = require('../models/MediaAsset');
const Report = require('../models/Report');
const Block = require('../models/Block');
const AdminAuditLog = require('../models/AdminAuditLog');
const AppError = require('../utils/AppError');
const realtime = require('./realtime');
const audit = require('./adminAuditService');
const { can, maskEmail } = require('../admin/permissions');

// IMPORTANT: everything here is METADATA. Message, memory, drawing, file and location contents are end-to-end encrypted;
// this service never reads them, and the counts below are just row counts.
const DAY = 86400000;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slice = (rows, limit) => ({ items: rows.slice(0, limit), nextBefore: rows.length > limit ? String(rows[limit - 1]._id) : null });
const who = (ctx) => ({ admin: ctx.admin, ip: ctx.ip });

// ---------- users ----------
async function listUsers(ctx, { q, status, before, limit = 25 }) {
  const and = [];
  if (status) and.push({ status });
  if (q) {
    const s = q.trim().toLowerCase();
    if (/^[a-f0-9]{24}$/.test(s)) and.push({ _id: s });
    else if (s.includes('@')) and.push({ email: new RegExp(`^${esc(s)}`) });
    else and.push({ username: new RegExp(`^${esc(s)}`) });
  }
  if (before) and.push({ _id: { $lt: before } });
  const { items, nextBefore } = slice(await User.find(and.length ? { $and: and } : {}).sort({ _id: -1 }).limit(limit + 1), limit);
  const counts = await Report.aggregate([{ $match: { targetUserId: { $in: items.map((u) => u._id) } } }, { $group: { _id: '$targetUserId', n: { $sum: 1 } } }]);
  const byId = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  const showEmail = can(ctx.admin.role, 'users:read-email');
  return {
    users: items.map((u) => ({
      id: u.id, username: u.username, email: showEmail ? u.email : maskEmail(u.email), status: u.status, createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt ?? null, emailVerified: Boolean(u.emailVerifiedAt), inRoom: Boolean(u.coupleId), reportsAgainst: byId[u.id] ?? 0,
    })),
    nextBefore,
  };
}

async function userDetail(ctx, id) {
  const u = await User.findById(id);
  if (!u) throw new AppError(404, 'NOT_FOUND', 'No such user');
  const [devices, sessions, couple, blocking, blockedBy, against, filed] = await Promise.all([
    Device.countDocuments({ userId: u._id, revokedAt: null }),
    RefreshToken.countDocuments({ userId: u._id, revokedAt: null, expiresAt: { $gt: new Date() } }),
    u.coupleId ? Couple.findById(u.coupleId).select('status createdAt') : null,
    Block.countDocuments({ blockerId: u._id }),
    Block.countDocuments({ blockedId: u._id }),
    Report.find({ targetUserId: u._id }).sort({ createdAt: -1 }).limit(10).select('category status createdAt'),
    Report.countDocuments({ reporterId: u._id }),
  ]);
  await audit.record({ ...who(ctx), action: 'users.view', targetType: 'user', targetId: id });
  return {
    id: u.id, username: u.username, displayName: u.displayName ?? null,
    email: can(ctx.admin.role, 'users:read-email') ? u.email : maskEmail(u.email), emailVerified: Boolean(u.emailVerifiedAt),
    status: u.status, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt ?? null, suspension: u.suspension?.reason ? u.suspension : null,
    deletionScheduledAt: u.deletionScheduledAt ?? null, devices, activeSessions: sessions,
    room: couple ? { id: String(couple._id), status: couple.status } : null, blocking, blockedBy, reportsFiled: filed,
    reportsAgainst: against.map((r) => ({ id: r.id, category: r.category, status: r.status, createdAt: r.createdAt })),
  };
}

async function suspendUser(ctx, id, reason) {
  const u = await User.findById(id);
  if (!u) throw new AppError(404, 'NOT_FOUND', 'No such user');
  if (u.status !== 'active') throw new AppError(409, 'BAD_STATE', `This account is ${u.status.replace('_', ' ')}`);
  await User.updateOne({ _id: id, status: 'active' }, { $set: { status: 'suspended', suspension: { reason, at: new Date(), by: ctx.admin.email } }, $inc: { tokenVersion: 1 } });
  await RefreshToken.updateMany({ userId: id, revokedAt: null }, { $set: { revokedAt: new Date() } }); // signed out everywhere right now
  await audit.record({ ...who(ctx), action: 'users.suspend', targetType: 'user', targetId: id, details: { reason, username: u.username } });
}
async function reactivateUser(ctx, id, reason) {
  const u = await User.findById(id);
  if (!u) throw new AppError(404, 'NOT_FOUND', 'No such user');
  if (u.status !== 'suspended') throw new AppError(409, 'BAD_STATE', 'This account is not suspended');
  await User.updateOne({ _id: id, status: 'suspended' }, { $set: { status: 'active' }, $unset: { suspension: 1 } });
  await audit.record({ ...who(ctx), action: 'users.reactivate', targetType: 'user', targetId: id, details: { reason, username: u.username } });
}

// ---------- rooms ----------
async function memberNames(ids) {
  const users = await User.find({ _id: { $in: ids } }).select('username');
  return Object.fromEntries(users.map((u) => [u.id, u.username]));
}
const roomView = (c, names) => ({
  id: c.id, status: c.status, createdAt: c.createdAt, activatedAt: c.activatedAt ?? null, closedAt: c.closedAt ?? null, keyVersion: c.keyVersion,
  storageUsedBytes: c.storageUsed, members: c.members.map((m) => ({ id: String(m), username: names[String(m)] ?? null })), suspension: c.suspension?.reason ? c.suspension : null,
});

async function listRooms(ctx, { q, status, before, limit = 25 }) {
  const and = [];
  if (status) and.push({ status });
  if (q) {
    const s = q.trim().toLowerCase();
    if (/^[a-f0-9]{24}$/.test(s)) and.push({ _id: s });
    else { const u = await User.findOne({ username: s }).select('coupleId'); and.push({ _id: u?.coupleId ?? new mongoose.Types.ObjectId() }); }
  }
  if (before) and.push({ _id: { $lt: before } });
  const { items, nextBefore } = slice(await Couple.find(and.length ? { $and: and } : {}).sort({ _id: -1 }).limit(limit + 1), limit);
  const names = await memberNames(items.flatMap((c) => c.members));
  return { rooms: items.map((c) => roomView(c, names)), nextBefore };
}

async function roomDetail(ctx, id) {
  const c = await Couple.findById(id);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'No such room');
  const [messages, canvases, memories, files, pendingInvites, devices] = await Promise.all([
    Message.countDocuments({ coupleId: c._id }), Canvas.countDocuments({ coupleId: c._id, archivedAt: null }),
    Memory.countDocuments({ coupleId: c._id, deletedAt: null }), MediaAsset.countDocuments({ coupleId: c._id, status: { $ne: 'deleted' } }),
    Invitation.countDocuments({ coupleId: c._id, status: { $in: ['pending', 'accepted'] } }), Device.countDocuments({ userId: { $in: c.members }, revokedAt: null }),
  ]);
  const names = await memberNames(c.members);
  await audit.record({ ...who(ctx), action: 'rooms.view', targetType: 'room', targetId: id });
  // Counts only. There is deliberately no way to read what was said, drawn, saved or shared.
  return { ...roomView(c, names), counts: { messages, canvases, memories, files, pendingInvitations: pendingInvites, devices } };
}

async function suspendRoom(ctx, id, reason) {
  const c = await Couple.findById(id);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'No such room');
  if (!['active', 'pending'].includes(c.status)) throw new AppError(409, 'BAD_STATE', `This room is ${c.status}`);
  await Couple.updateOne({ _id: id, status: c.status }, { $set: { status: 'suspended', suspension: { reason, at: new Date(), by: ctx.admin.email, previousStatus: c.status } } });
  realtime.emitToCouple(String(id), 'couple:suspended', {});
  await audit.record({ ...who(ctx), action: 'rooms.suspend', targetType: 'room', targetId: id, details: { reason, previousStatus: c.status } });
}
async function reactivateRoom(ctx, id, reason) {
  const c = await Couple.findById(id);
  if (!c) throw new AppError(404, 'NOT_FOUND', 'No such room');
  if (c.status !== 'suspended') throw new AppError(409, 'BAD_STATE', 'This room is not suspended');
  await Couple.updateOne({ _id: id, status: 'suspended' }, { $set: { status: c.suspension?.previousStatus === 'pending' ? 'pending' : 'active' }, $unset: { suspension: 1 } });
  await audit.record({ ...who(ctx), action: 'rooms.reactivate', targetType: 'room', targetId: id, details: { reason } });
}

// ---------- reports ----------
const reportView = (r, names = {}) => ({
  id: r.id, category: r.category, status: r.status, createdAt: r.createdAt, reporter: names[String(r.reporterId)] ?? null,
  target: r.targetUsername, targetUserId: r.targetUserId ? String(r.targetUserId) : null, roomId: r.coupleId ? String(r.coupleId) : null,
});
async function listReports(ctx, { status, before, limit = 25 }) {
  const q = {};
  if (status) q.status = status;
  if (before) q._id = { $lt: before };
  const { items, nextBefore } = slice(await Report.find(q).sort({ _id: -1 }).limit(limit + 1), limit);
  const names = await memberNames(items.map((r) => r.reporterId));
  return { reports: items.map((r) => reportView(r, names)), nextBefore };
}
async function reportDetail(ctx, id) {
  const r = await Report.findById(id);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'No such report');
  const names = await memberNames([r.reporterId]);
  await audit.record({ ...who(ctx), action: 'reports.view', targetType: 'report', targetId: id });
  // `details` and `evidence` are text the REPORTER chose to send us. We cannot verify them, because messages are encrypted.
  return { ...reportView(r, names), details: r.details, evidence: r.evidence, resolution: r.resolution ?? null, handledAt: r.handledAt ?? null };
}
async function handleReport(ctx, id, { status, resolution }) {
  const r = await Report.findByIdAndUpdate(id, { $set: { status, resolution: resolution ?? '', handledAt: new Date() } }, { new: true });
  if (!r) throw new AppError(404, 'NOT_FOUND', 'No such report');
  await audit.record({ ...who(ctx), action: 'reports.handle', targetType: 'report', targetId: id, details: { status, resolution: resolution ?? '' } });
  return reportView(r);
}

// ---------- abuse, stats, alerts ----------
async function abuse() {
  const since = new Date(Date.now() - DAY);
  const [inviters, targets] = await Promise.all([
    Invitation.aggregate([{ $match: { createdAt: { $gt: since } } }, { $group: { _id: '$inviterId', n: { $sum: 1 } } }, { $match: { n: { $gte: 5 } } }, { $sort: { n: -1 } }, { $limit: 20 }]),
    Report.aggregate([{ $match: { createdAt: { $gt: new Date(Date.now() - 30 * DAY) }, targetUserId: { $ne: null } } }, { $group: { _id: '$targetUserId', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]),
  ]);
  const names = await memberNames([...inviters, ...targets].map((x) => x._id));
  return {
    heavyInviters: inviters.map((x) => ({ userId: String(x._id), username: names[String(x._id)] ?? null, invitationsLast24h: x.n })),
    mostReported: targets.map((x) => ({ userId: String(x._id), username: names[String(x._id)] ?? null, reportsLast30d: x.n })),
  };
}

async function stats() {
  const now = Date.now();
  const ago = (n) => new Date(now - n * DAY);
  const distinct = async (since) => (await RefreshToken.aggregate([{ $match: { createdAt: { $gt: since } } }, { $group: { _id: '$userId' } }, { $count: 'n' }]))[0]?.n ?? 0;
  const group = async (Model, field) => Object.fromEntries((await Model.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }])).map((x) => [x._id, x.n]));
  const t0 = Date.now();
  await mongoose.connection.db.admin().ping();
  const dbMs = Date.now() - t0;
  const [users, couples, newDay, newWeek, newMonth, dau, mau, pendingInvitations, openReports, storage, openAssets] = await Promise.all([
    group(User, 'status'), group(Couple, 'status'), User.countDocuments({ createdAt: { $gt: ago(1) } }), User.countDocuments({ createdAt: { $gt: ago(7) } }),
    User.countDocuments({ createdAt: { $gt: ago(30) } }), distinct(ago(1)), distinct(ago(30)),
    Invitation.countDocuments({ status: { $in: ['pending', 'accepted'] }, expiresAt: { $gt: new Date() } }), Report.countDocuments({ status: { $in: ['open', 'reviewing'] } }),
    Couple.aggregate([{ $group: { _id: null, bytes: { $sum: '$storageUsed' } } }]), MediaAsset.countDocuments({ status: 'ready' }),
  ]);
  return {
    users: { total: Object.values(users).reduce((a, b) => a + b, 0), byStatus: users, newLast24h: newDay, newLast7d: newWeek, newLast30d: newMonth, dailyActive: dau, monthlyActive: mau },
    rooms: { byStatus: couples, connectedCouples: couples.active ?? 0 },
    pendingInvitations, openReports, storage: { usedBytes: storage[0]?.bytes ?? 0, files: openAssets },
    online: { users: realtime.onlineUsers() },
    health: { api: 'ok', database: { ok: true, pingMs: dbMs }, realtime: { onlineUsers: realtime.onlineUsers() }, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576), calls: 'not configured yet' },
    subscriptions: { configured: false },
  };
}

async function alerts() {
  const now = Date.now();
  const since = new Date(now - DAY);
  const count = (action) => AdminAuditLog.countDocuments({ action, createdAt: { $gt: since } });
  const [failed, locked, newIp, reuse, lockedUsers, signupsHour, staleReports, openReports] = await Promise.all([
    count('auth.login_failed'), count('auth.locked'), count('auth.new_ip'), count('auth.refresh_reuse'),
    User.countDocuments({ lockUntil: { $gt: new Date() } }), User.countDocuments({ createdAt: { $gt: new Date(now - 3600000) } }),
    Report.countDocuments({ status: 'open', createdAt: { $lt: new Date(now - 2 * DAY) } }), Report.countDocuments({ status: 'open' }),
  ]);
  const out = [];
  const add = (level, code, message, n) => { if (n > 0) out.push({ level, code, message, count: n }); };
  add('high', 'admin_refresh_reuse', 'An admin session token was reused. That can mean a stolen session; the session family was revoked.', reuse);
  add('high', 'admin_lockout', 'Admin accounts were locked after repeated failures in the last 24 hours.', locked);
  add('medium', 'admin_failed_logins', 'Failed admin sign-in attempts in the last 24 hours.', failed);
  add('medium', 'admin_new_ip', 'Admins signed in from a new network address in the last 24 hours.', newIp);
  add('medium', 'signup_spike', 'More than 50 new accounts were created in the last hour.', signupsHour > 50 ? signupsHour : 0);
  add('medium', 'stale_reports', 'Open reports older than 48 hours.', staleReports);
  add('low', 'user_lockouts', 'User accounts are currently locked after failed logins.', lockedUsers);
  add('info', 'open_reports', 'Open reports waiting for review.', openReports);
  return { alerts: out };
}

module.exports = {
  listUsers, userDetail, suspendUser, reactivateUser, listRooms, roomDetail, suspendRoom, reactivateRoom,
  listReports, reportDetail, handleReport, abuse, stats, alerts,
};
