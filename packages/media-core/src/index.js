// Dependency-free media + memories rules shared by the API and the web app.
//  - What file types are allowed (decided by CONTENT sniffing, never by file name or declared type alone).
//  - The encrypted-file size formula (so the server can reserve exact quota before upload).
//  - Validation/sanitising of DECRYPTED descriptors and memory payloads (a partner's client is not trusted to be well-formed).
const CHUNK = 1 << 20; // plaintext bytes per secretstream chunk
const HEADER = 24; // secretstream header
const ABYTES = 17; // per-chunk authentication overhead
const MB = 1024 * 1024;
const LIMITS = { image: 25 * MB, video: 100 * MB, audio: 25 * MB, thumb: 512 * 1024 };
const MIME_KIND = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'video/mp4': 'video', 'video/webm': 'video',
  'audio/webm': 'audio', 'audio/ogg': 'audio', 'audio/mp4': 'audio', 'audio/mpeg': 'audio',
};
const MEMORY_TYPES = ['photo', 'video', 'voice', 'drawing', 'message', 'note', 'letter', 'date'];
const HEX24 = /^[a-f0-9]{24}$/;
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes, canonical base64

const kindForMime = (mime) => MIME_KIND[mime] || null;
const encryptedSize = (plainLen, chunk = CHUNK) => HEADER + plainLen + ABYTES * Math.max(1, Math.ceil(plainLen / chunk));
const formatBytes = (n) => (n < 1024 ? `${n} B` : n < MB ? `${(n / 1024).toFixed(0)} KB` : n < 1024 * MB ? `${(n / MB).toFixed(1)} MB` : `${(n / (1024 * MB)).toFixed(2)} GB`);

const ascii = (b, from, s) => s.split('').every((ch, i) => b[from + i] === ch.charCodeAt(0));
const BAD_BRANDS = ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif', 'avis'];

/** Returns an allowed mime type based on the file's leading bytes, or null. SVG/HTML/executables never match. */
function sniffMime(bytes, declared = '') {
  const b = bytes;
  if (!b || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 6 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (b.length >= 12 && ascii(b, 4, 'ftyp')) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (BAD_BRANDS.includes(brand)) return null; // HEIC/AVIF: most browsers cannot display it
    return declared === 'audio/mp4' || brand.startsWith('M4A') || brand.startsWith('M4B') ? 'audio/mp4' : 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return declared === 'audio/webm' ? 'audio/webm' : declared === 'video/webm' ? 'video/webm' : null;
  if (ascii(b, 0, 'OggS')) return 'audio/ogg';
  if (ascii(b, 0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const str = (s, max) => typeof s === 'string' && s.length <= max;
const cleanName = (s) => String(s).replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '').trim().slice(0, 120);

function validateThumb(t) {
  if (!t || typeof t !== 'object' || !HEX24.test(t.id) || !KEY_B64.test(t.key) || t.mime !== 'image/jpeg' || !int(t.w, 1, 2000) || !int(t.h, 1, 2000)) return null;
  return { id: t.id, key: t.key, mime: 'image/jpeg', w: t.w, h: t.h };
}

/** A descriptor says where an encrypted file is and how to decrypt it. It only ever exists inside encrypted payloads. */
function validateDescriptor(d) {
  if (!d || typeof d !== 'object' || !HEX24.test(d.id) || !KEY_B64.test(d.key)) return null;
  const kind = MIME_KIND[d.mime];
  if (!kind || !int(d.size, 0, LIMITS[kind])) return null;
  const out = { id: d.id, key: d.key, mime: d.mime, size: d.size };
  if (typeof d.name === 'string') { const n = cleanName(d.name); if (n) out.name = n; }
  if (d.w !== undefined || d.h !== undefined) { if (!int(d.w, 1, 20000) || !int(d.h, 1, 20000)) return null; out.w = d.w; out.h = d.h; }
  if (d.dur !== undefined) { if (typeof d.dur !== 'number' || !Number.isFinite(d.dur) || d.dur < 0 || d.dur > 86400) return null; out.dur = Math.round(d.dur * 10) / 10; }
  if (d.voice === true && kind === 'audio') out.voice = true;
  if (d.thumb !== undefined && kind !== 'audio') { const t = validateThumb(d.thumb); if (t) out.thumb = t; }
  return out;
}

const NEEDS_MEDIA = { photo: 'image', video: 'video', voice: 'audio', drawing: 'image' };
/** Sanitise a decrypted memory payload for the given type. Returns null if it does not fit the type. */
function validateMemoryPayload(p, type) {
  if (!p || typeof p !== 'object' || !MEMORY_TYPES.includes(type)) return null;
  const out = { v: 1 };
  for (const [k, max] of [['title', 120], ['caption', 2000], ['text', 20000], ['from', 60]]) {
    if (p[k] !== undefined) { if (!str(p[k], max)) return null; if (p[k] !== '') out[k] = p[k]; }
  }
  if (p.sentAt !== undefined) { if (!int(p.sentAt, 0, 8.64e15)) return null; out.sentAt = p.sentAt; }
  if (p.media !== undefined) {
    if (!Array.isArray(p.media) || p.media.length > 4) return null;
    const media = p.media.map(validateDescriptor);
    if (media.some((m) => !m)) return null;
    out.media = media;
  }
  const need = NEEDS_MEDIA[type];
  if (need && !(out.media && out.media.length >= 1 && out.media.every((m) => MIME_KIND[m.mime] === need))) return null;
  if ((type === 'note' || type === 'letter') && !out.text) return null;
  if (type === 'date' && !out.title) return null;
  if (type === 'message' && !out.text && !out.media) return null;
  return out;
}

// Opaque pagination cursor for (eventDate desc, _id desc).
const encodeCursor = (ms, id) => Buffer.from(`${ms}:${id}`).toString('base64url');
function decodeCursor(c) {
  if (typeof c !== 'string' || c.length > 100) return null;
  let raw;
  try { raw = Buffer.from(c, 'base64url').toString(); } catch { return null; }
  const m = /^(-?\d{1,16}):([a-f0-9]{24})$/.exec(raw);
  return m ? { ms: Number(m[1]), id: m[2] } : null;
}

module.exports = {
  CHUNK, HEADER, ABYTES, LIMITS, MIME_KIND, MEMORY_TYPES,
  kindForMime, encryptedSize, formatBytes, sniffMime, validateDescriptor, validateThumb, validateMemoryPayload, encodeCursor, decodeCursor,
};
