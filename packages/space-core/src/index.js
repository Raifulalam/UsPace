// Pure helpers for the Our Space home screen and chat extras (no dependencies, testable without a browser).
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- anniversary maths (calendar dates, UTC arithmetic so there are no daylight-saving surprises) ----------
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? { y, mo, d } : null;
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Today's CALENDAR day in the user's own time zone, as a timestamp the maths above understands. */
const localTodayMs = (d = new Date()) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * @param dateStr  YYYY-MM-DD the couple chose
 * @param todayMs  midnight-UTC timestamp of the calendar day to measure from (use localTodayMs())
 * Feb 29 anniversaries fall on Feb 28 in non-leap years. A date in the future counts down to that date.
 */
function anniversaryInfo(dateStr, todayMs = localTodayMs()) {
  const p = parseDate(dateStr);
  if (!p) return null;
  const start = Date.UTC(p.y, p.mo - 1, p.d);
  const today = new Date(todayMs);
  const ty = today.getUTCFullYear();
  if (start > todayMs) return { upcoming: true, daysTogether: Math.floor((todayMs - start) / DAY), daysToNext: Math.round((start - todayMs) / DAY), years: 0, isToday: false, nextDate: iso(start) };
  const on = (year) => Date.UTC(year, p.mo - 1, p.mo === 2 && p.d === 29 && !isLeap(year) ? 28 : p.d);
  let year = ty;
  let next = on(year);
  if (next < todayMs) { year += 1; next = on(year); }
  return {
    upcoming: false, daysTogether: Math.floor((todayMs - start) / DAY), daysToNext: Math.round((next - todayMs) / DAY),
    years: year - p.y, isToday: next === todayMs, nextDate: iso(next),
  };
}

// ---------- display helpers ----------
const initialsOf = (name) => {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = (w) => Array.from(w)[0].toUpperCase();
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
};
/** Stable colour for an avatar, derived from a username. */
function hueOf(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
function formatRelative(thenMs, nowMs = Date.now()) {
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : new Date(thenMs).toISOString().slice(0, 10);
}
/** 'YYYY-MM-DD' of an instant in a given time zone offset (minutes east of UTC). Used for date dividers in chat. */
const dayKey = (isoString, offsetMinutes = 0) => new Date(Date.parse(isoString) + offsetMinutes * 60000).toISOString().slice(0, 10);
function groupByDay(items, getIso, offsetMinutes = 0) {
  const groups = [];
  for (const item of items) {
    const key = dayKey(getIso(item), offsetMinutes);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item); else groups.push({ key, items: [item] });
  }
  return groups;
}

// ---------- chat extras ----------
const TTL_OPTIONS = [
  { sec: 0, label: 'Off' }, { sec: 3600, label: '1 hour' }, { sec: 86400, label: '24 hours' }, { sec: 604800, label: '7 days' }, { sec: 2592000, label: '30 days' },
];
const ALLOWED_TTL = TTL_OPTIONS.map((o) => o.sec);
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const STICKERS = ['💜', '🥰', '😘', '🤗', '😍', '🎉', '✨', '🌹', '🍕', '🎶', '🏖️', '🌙'];

/** Decrypted reaction payloads are untrusted: only allow-listed emoji get through. */
const validateReaction = (p) => (p && typeof p === 'object' && REACTIONS.includes(p.emoji) ? p.emoji : null);
const validateSticker = (p) => (p && typeof p === 'object' && STICKERS.includes(p.sticker) ? p.sticker : null);
/** A reply points at another message by its client id; anything else is ignored. */
const validateReplyTo = (v) => (typeof v === 'string' && UUID.test(v) ? v : null);

/** Walks the list from newest to oldest and returns the newest message this person sent that the partner has seen. */
function lastSeenMessageId(messages, partnerLastReadId, myId) {
  if (!partnerLastReadId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.id && m.senderId === myId && m.id <= partnerLastReadId) return m.id; // ObjectIds sort by creation time
  }
  return null;
}

module.exports = {
  DAY, anniversaryInfo, localTodayMs, parseDate, isLeap, initialsOf, hueOf, formatRelative, dayKey, groupByDay,
  TTL_OPTIONS, ALLOWED_TTL, REACTIONS, STICKERS, validateReaction, validateSticker, validateReplyTo, lastSeenMessageId,
};
