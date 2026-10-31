// Pure, dependency-free canvas logic shared by the web client (and testable without a browser).
//  - Logical coordinate space is W x H, independent of screen size.
//  - Every drawing action is an "op". Ops are encrypted; the server only assigns them a sequence number.
//  - computeScene() turns an unordered pile of ops into what should be visible, deterministically.
//  - validateOp()/validateLive() sanitise DECRYPTED payloads: a partner's client is not trusted to be well-formed.
const W = 1000;
const H = 700;
const TOOLS = ['pen', 'brush', 'eraser'];
const STICKERS = ['heart', 'star', 'flower', 'arrow', 'spark'];
const PATTERNS = ['none', 'dots', 'grid', 'lines', 'hearts'];
const MAX_STROKE_COORDS = 3000; // 1500 points per committed stroke (clients split longer strokes)
const MAX_LIVE_COORDS = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_BG = { color: '#fff7fb', pattern: 'none' };

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cx = (n) => clamp(Math.round(n), -50, W + 50);
const cy = (n) => clamp(Math.round(n), -50, H + 50);

function cleanPts(pts, max) {
  if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 !== 0 || pts.length > max) return null;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    if (!isNum(pts[i])) return null;
    out[i] = i % 2 === 0 ? cx(pts[i]) : cy(pts[i]);
  }
  return out;
}

function validateOp(op) {
  if (!op || typeof op !== 'object') return null;
  switch (op.t) {
    case 'stroke': {
      if (!UUID.test(op.id) || !TOOLS.includes(op.tool) || !COLOR.test(op.color) || !isNum(op.size)) return null;
      const pts = cleanPts(op.pts, MAX_STROKE_COORDS);
      return pts ? { t: 'stroke', id: op.id, tool: op.tool, color: op.color, size: clamp(Math.round(op.size), 1, 64), pts } : null;
    }
    case 'text': {
      if (!UUID.test(op.id) || typeof op.text !== 'string' || op.text.length < 1 || op.text.length > 280) return null;
      if (!isNum(op.x) || !isNum(op.y) || !COLOR.test(op.color) || !isNum(op.size)) return null;
      return { t: 'text', id: op.id, text: op.text, x: cx(op.x), y: cy(op.y), color: op.color, size: clamp(Math.round(op.size), 8, 160) };
    }
    case 'sticker': {
      if (!UUID.test(op.id) || !STICKERS.includes(op.kind) || !isNum(op.x) || !isNum(op.y) || !COLOR.test(op.color) || !isNum(op.size)) return null;
      return { t: 'sticker', id: op.id, kind: op.kind, x: cx(op.x), y: cy(op.y), color: op.color, size: clamp(Math.round(op.size), 16, 320), rot: isNum(op.rot) ? clamp(op.rot, -360, 360) : 0 };
    }
    case 'undo':
    case 'redo':
      return UUID.test(op.target) ? { t: op.t, target: op.target } : null;
    case 'clear':
      return { t: 'clear' };
    case 'bg':
      return COLOR.test(op.color) && PATTERNS.includes(op.pattern) ? { t: 'bg', color: op.color, pattern: op.pattern } : null;
    default:
      return null;
  }
}

// Ephemeral previews (never stored). Same rules, smaller limits; empty text means "remove the preview".
function validateLive(p) {
  if (!p || typeof p !== 'object' || !UUID.test(p.sid)) return null;
  if (p.k === 'stroke') {
    if (!TOOLS.includes(p.tool) || !COLOR.test(p.color) || !isNum(p.size)) return null;
    const pts = cleanPts(p.pts, MAX_LIVE_COORDS);
    return pts ? { k: 'stroke', sid: p.sid, tool: p.tool, color: p.color, size: clamp(Math.round(p.size), 1, 64), pts, start: p.start === true } : null;
  }
  if (p.k === 'text') {
    if (typeof p.text !== 'string' || p.text.length > 280 || !isNum(p.x) || !isNum(p.y) || !COLOR.test(p.color) || !isNum(p.size)) return null;
    return { k: 'text', sid: p.sid, text: p.text, x: cx(p.x), y: cy(p.y), color: p.color, size: clamp(Math.round(p.size), 8, 160) };
  }
  return null;
}

/**
 * entries: [{ seq, senderId, op }]. Pending local ops use seq = Infinity and sort last.
 * Rules: ops apply in seq order; `clear` wipes everything drawn before it; undo/redo only affect the
 * sender's OWN drawings and the latest vote per target wins (so an undo that arrives "before" its target still works).
 */
function computeScene(entries) {
  const seenSeq = new Set();
  const list = [];
  for (const e of entries) {
    if (Number.isFinite(e.seq)) {
      if (seenSeq.has(e.seq)) continue;
      seenSeq.add(e.seq);
    }
    list.push(e);
  }
  list.sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? -1 : 1));

  let drawables = [];
  const votes = new Map();
  let bg = { ...DEFAULT_BG };
  for (const e of list) {
    const op = e.op;
    if (op.t === 'stroke' || op.t === 'text' || op.t === 'sticker') drawables.push(e);
    else if (op.t === 'undo' || op.t === 'redo') votes.set(op.target, { hidden: op.t === 'undo', by: e.senderId });
    else if (op.t === 'clear') drawables = [];
    else if (op.t === 'bg') bg = { color: op.color, pattern: op.pattern };
  }
  const visible = [];
  const hidden = [];
  for (const d of drawables) {
    const v = votes.get(d.op.id);
    (v && v.hidden && v.by === d.senderId ? hidden : visible).push(d);
  }
  return { visible, hidden, bg };
}

function undoCandidate(scene, me) {
  for (let i = scene.visible.length - 1; i >= 0; i--) if (scene.visible[i].senderId === me) return scene.visible[i].op.id;
  return null;
}
const hiddenIdsBy = (scene, me) => scene.hidden.filter((d) => d.senderId === me).map((d) => d.op.id);

module.exports = {
  W, H, TOOLS, STICKERS, PATTERNS, DEFAULT_BG, MAX_STROKE_COORDS, MAX_LIVE_COORDS,
  validateOp, validateLive, computeScene, undoCandidate, hiddenIdsBy,
};
