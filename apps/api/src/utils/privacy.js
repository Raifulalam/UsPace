// Small pure helpers for privacy-sensitive output and retention timing (unit-tested without a database).
const DAY = 86400000;
const CLOSED_COUPLE_RETENTION_DAYS = 30; // closed rooms: all content is permanently deleted after this
const DELETION_GRACE_DAYS = 14; // account deletion can be cancelled during this window

/** Coarse IP for showing in "your devices": keep the network, drop the host. */
function maskIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v4 = ip.replace(/^::ffff:/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:…`;
  return null;
}

/** Human label for a session from its User-Agent. Never returns the raw string. */
function describeAgent(ua) {
  const s = String(ua || '');
  if (/okhttp/i.test(s)) return 'Android app';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null;
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'Unknown device';
}

const deletionDate = (now = Date.now()) => new Date(now + DELETION_GRACE_DAYS * DAY);
const closedCoupleCutoff = (now = Date.now()) => new Date(now - CLOSED_COUPLE_RETENTION_DAYS * DAY);

module.exports = { DAY, CLOSED_COUPLE_RETENTION_DAYS, DELETION_GRACE_DAYS, maskIp, describeAgent, deletionDate, closedCoupleCutoff };
