// Pure call rules (unit-tested without a database or sockets).
const crypto = require('crypto');

// ringing -> answered | missed (nobody picked up) | rejected | canceled (caller hung up first)
// answered -> ended | failed. Anything else is refused, so a stale or replayed event can never revive a finished call.
const TRANSITIONS = { ringing: ['answered', 'missed', 'rejected', 'canceled'], answered: ['ended', 'failed'] };
const ACTIVE = Object.keys(TRANSITIONS);
const canTransition = (from, to) => Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
const isActive = (status) => ACTIVE.includes(status);

const RING_TIMEOUT_MS = 45_000;
const STALE_RINGING_MS = 90_000; // a ringing row this old means the server restarted mid-ring
const STALE_ANSWERED_MS = 6 * 3600_000; // no call lasts this long: the end event was lost
const OFFLINE_GRACE_MS = 15_000; // a dropped connection gets this long to come back before the call is ended

const durationSec = (answeredAt, endedAt) => (answeredAt && endedAt ? Math.max(0, Math.round((new Date(endedAt) - new Date(answeredAt)) / 1000)) : 0);

/**
 * Relay (TURN) credentials in the format coturn's `use-auth-secret` REST mode expects: the username carries its own expiry,
 * and the password is HMAC-SHA1(secret, username). Nothing is stored, and a leaked credential stops working after `ttlSec`.
 */
function turnCredentials({ secret, userId, nowMs = Date.now(), ttlSec = 3600 }) {
  const username = `${Math.floor(nowMs / 1000) + ttlSec}:${userId}`;
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64'), ttlSec };
}

const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** What the browser needs to connect: public STUN to discover its address, plus TURN relay if configured. */
function buildIceServers({ stunUrls, turnUrls, turnSecret, userId, nowMs, ttlSec }) {
  const out = [];
  const stun = splitList(stunUrls);
  if (stun.length) out.push({ urls: stun });
  const turn = splitList(turnUrls);
  if (turn.length && turnSecret) {
    const c = turnCredentials({ secret: turnSecret, userId, nowMs, ttlSec });
    out.push({ urls: turn, username: c.username, credential: c.credential });
  }
  return out;
}

module.exports = {
  TRANSITIONS, canTransition, isActive, RING_TIMEOUT_MS, STALE_RINGING_MS, STALE_ANSWERED_MS, OFFLINE_GRACE_MS, durationSec, turnCredentials, buildIceServers, splitList,
};
