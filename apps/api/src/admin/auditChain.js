// Tamper-evident audit log: each entry's hash covers the previous entry's hash, so editing, deleting, inserting or
// reordering any past entry breaks every hash after it. Verifying the chain proves the log is intact.
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const FIELDS = ['seq', 'adminId', 'adminEmail', 'action', 'targetType', 'targetId', 'details', 'ip', 'at'];
function entryHash(prevHash, e) {
  const body = {};
  for (const f of FIELDS) body[f] = e[f] === undefined ? null : e[f];
  return crypto.createHash('sha256').update(`${prevHash}|${canonical(body)}`).digest('hex');
}

/** entries: oldest first, each { seq, prevHash, hash, adminId, adminEmail, action, targetType, targetId, details, ip, at (ISO) } */
function verifyChain(entries) {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAt: e.seq, reason: e.seq > expectedSeq ? 'an entry is missing' : 'entries out of order' };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: 'chain link does not match the previous entry' };
    if (entryHash(prev, e) !== e.hash) return { ok: false, brokenAt: e.seq, reason: 'entry content was altered' };
    prev = e.hash;
    expectedSeq++;
  }
  return { ok: true, count: entries.length, head: prev };
}

module.exports = { GENESIS, canonical, entryHash, verifyChain };
