const AdminAuditLog = require('../models/AdminAuditLog');
const { GENESIS, entryHash, verifyChain } = require('../admin/auditChain');

/** Appends one tamper-evident entry. Retries if two admins write at the same instant (the unique `seq` serialises them). */
async function record({ admin = null, email = null, action, targetType = null, targetId = null, details = {}, ip = null }) {
  const cleanDetails = JSON.parse(JSON.stringify(details ?? {}));
  for (let attempt = 0; attempt < 8; attempt++) {
    const last = await AdminAuditLog.findOne().sort({ seq: -1 }).lean();
    const createdAt = new Date();
    const fields = {
      seq: (last?.seq ?? 0) + 1, adminId: admin ? String(admin._id) : null, // a plain string: database ids flatten to {} when hashed adminEmail: admin ? admin.email : email, action,
      targetType, targetId: targetId == null ? null : String(targetId), details: cleanDetails, ip, at: createdAt.toISOString(),
    };
    const prevHash = last?.hash ?? GENESIS;
    try {
      return await AdminAuditLog.create({ ...fields, createdAt, prevHash, hash: entryHash(prevHash, fields) });
    } catch (e) {
      if (e.code !== 11000) throw e; // someone else took this seq: read the new tail and try again
    }
  }
  throw new Error('Could not append to the audit log');
}

const view = (e) => ({ seq: e.seq, at: e.createdAt, admin: e.adminEmail, action: e.action, targetType: e.targetType, targetId: e.targetId, details: e.details, ip: e.ip });

async function list({ action, adminEmail, before, limit = 50 }) {
  const q = {};
  if (action) q.action = action;
  if (adminEmail) q.adminEmail = adminEmail.toLowerCase();
  if (before) q.seq = { $lt: before };
  const rows = await AdminAuditLog.find(q).sort({ seq: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  return { entries: page.map(view), nextBefore: rows.length > limit ? page[page.length - 1].seq : null };
}

/** Re-computes the whole chain. Detects edits, deletions in the middle, and reordering. */
async function verify() {
  const rows = await AdminAuditLog.find().sort({ seq: 1 }).lean();
  const result = verifyChain(rows.map((r) => ({ ...r, adminId: r.adminId ? String(r.adminId) : null, at: r.createdAt.toISOString() })));
  return result.ok ? { ok: true, entries: result.count, head: result.head } : { ok: false, brokenAtSeq: result.brokenAt, reason: result.reason };
}

module.exports = { record, list, verify };
