import { W, H, type Bg, type Entry, type Scene, type Sticker } from '@couples/canvas-core';

export type LiveItem = {
  sid: string; senderId: string; k: 'stroke' | 'text'; lastAt: number; color: string; size: number;
  tool?: string; pts?: number[]; text?: string; x?: number; y?: number;
};

const FONT = 'ui-rounded, system-ui, -apple-system, "Segoe UI", sans-serif';

/** Size a canvas for crisp rendering and return a context whose units are the logical W x H space. */
export function fit(canvas: HTMLCanvasElement, cssW: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const cssH = (cssW * H) / W;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  return ctx;
}

function heartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.8);
  ctx.bezierCurveTo(cx - r, cy + r * 0.1, cx - r * 0.8, cy - r * 0.8, cx, cy - r * 0.35);
  ctx.bezierCurveTo(cx + r * 0.8, cy - r * 0.8, cx + r, cy + r * 0.1, cx, cy + r * 0.8);
  ctx.closePath();
}

export function drawBackground(ctx: CanvasRenderingContext2D, bg: Bg) {
  ctx.save();
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(120,100,160,0.18)';
  ctx.fillStyle = 'rgba(120,100,160,0.18)';
  ctx.lineWidth = 1;
  if (bg.pattern === 'dots') {
    for (let x = 20; x < W; x += 40) for (let y = 20; y < H; y += 40) { ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill(); }
  } else if (bg.pattern === 'grid') {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += 50) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  } else if (bg.pattern === 'lines') {
    ctx.beginPath();
    for (let y = 40; y <= H; y += 40) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  } else if (bg.pattern === 'hearts') {
    ctx.fillStyle = 'rgba(219,39,119,0.13)';
    for (let row = 0, y = 45; y < H; y += 90, row++) for (let x = 45 + (row % 2) * 45; x < W; x += 90) { heartPath(ctx, x, y, 14); ctx.fill(); }
  }
  ctx.restore();
}

function strokePath(ctx: CanvasRenderingContext2D, pts: number[]) {
  ctx.beginPath();
  if (pts.length === 2) { ctx.arc(pts[0], pts[1], ctx.lineWidth / 2, 0, Math.PI * 2); return 'dot' as const; }
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    ctx.quadraticCurveTo(pts[i], pts[i + 1], mx, my);
  }
  ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1]);
  return 'line' as const;
}

function drawStroke(ctx: CanvasRenderingContext2D, tool: string, color: string, size: number, pts: number[], preview = false) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = tool === 'brush' ? size * 1.8 : tool === 'eraser' ? size * 3 : size;
  if (tool === 'eraser') {
    if (preview) { ctx.strokeStyle = 'rgba(140,140,160,0.45)'; ctx.fillStyle = ctx.strokeStyle; }
    else { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.fillStyle = '#000'; }
  } else {
    ctx.strokeStyle = color; ctx.fillStyle = color;
    if (tool === 'brush') ctx.globalAlpha = 0.65;
  }
  if (strokePath(ctx, pts) === 'dot') ctx.fill(); else ctx.stroke();
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, size: number) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = `${size}px ${FONT}`;
  ctx.textBaseline = 'top';
  text.split('\n').forEach((line, i) => ctx.fillText(line, x, y + i * size * 1.2));
  ctx.restore();
}

function drawSticker(ctx: CanvasRenderingContext2D, kind: Sticker, x: number, y: number, size: number, color: string, rot: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((rot * Math.PI) / 180);
  const r = size / 2;
  ctx.fillStyle = color;
  if (kind === 'heart') { heartPath(ctx, 0, 0, r); ctx.fill(); }
  else if (kind === 'star' || kind === 'spark') {
    const pointsN = kind === 'star' ? 5 : 4;
    const inner = kind === 'star' ? 0.45 : 0.25;
    ctx.beginPath();
    for (let i = 0; i < pointsN * 2; i++) {
      const a = (Math.PI * i) / pointsN - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * inner;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.fill();
  } else if (kind === 'flower') {
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5;
      ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, r * 0.45, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'arrow') {
    ctx.beginPath();
    const pts: [number, number][] = [[-1, -0.15], [0.3, -0.15], [0.3, -0.5], [1, 0], [0.3, 0.5], [0.3, 0.15], [-1, 0.15]];
    pts.forEach(([px, py]) => ctx.lineTo(px * r, py * r));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

export function drawEntry(ctx: CanvasRenderingContext2D, e: Entry) {
  const o = e.op;
  if (o.t === 'stroke') drawStroke(ctx, o.tool, o.color, o.size, o.pts);
  else if (o.t === 'text') drawText(ctx, o.text, o.x, o.y, o.color, o.size);
  else if (o.t === 'sticker') drawSticker(ctx, o.kind, o.x, o.y, o.size, o.color, o.rot);
}

/** Committed drawing layer: transparent canvas so the eraser never cuts holes in the background. */
export function renderScene(ctx: CanvasRenderingContext2D, scene: Scene) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (const e of scene.visible) drawEntry(ctx, e);
}

export function renderLive(ctx: CanvasRenderingContext2D, items: Iterable<LiveItem>) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  for (const it of items) {
    if (it.k === 'stroke' && it.pts && it.pts.length >= 2) drawStroke(ctx, it.tool ?? 'pen', it.color, it.size, it.pts, true);
    else if (it.k === 'text' && it.text) drawText(ctx, it.text, it.x ?? 0, it.y ?? 0, it.color, it.size);
  }
}

/** Composite background + drawing at 2x and return a PNG blob. */
export async function exportPng(scene: Scene, scale = 2): Promise<Blob | null> {
  const out = document.createElement('canvas');
  out.width = W * scale; out.height = H * scale;
  const octx = out.getContext('2d')!;
  octx.setTransform(scale, 0, 0, scale, 0, 0);
  drawBackground(octx, scene.bg);
  const layer = document.createElement('canvas');
  layer.width = W * scale; layer.height = H * scale;
  const lctx = layer.getContext('2d')!;
  lctx.setTransform(scale, 0, 0, scale, 0, 0);
  for (const e of scene.visible) drawEntry(lctx, e);
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.drawImage(layer, 0, 0);
  return new Promise((res) => out.toBlob(res, 'image/png'));
}
