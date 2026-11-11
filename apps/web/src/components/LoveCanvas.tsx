'use client';
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { Bookmark, Brush, Download, Eraser, Flower2, Heart, MoveRight, PenLine, Plus, Redo2, Sparkles, Star, Trash2, Type, Undo2 } from 'lucide-react';
import {
  W, H, PATTERNS, DEFAULT_BG, computeScene, undoCandidate, hiddenIdsBy, validateOp, validateLive,
  type Entry, type Op, type Scene, type Sticker, type Tool,
} from '@couples/canvas-core';
import { api, ApiError, tryRefresh } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import type { E2EE } from '@/lib/e2ee';
import type { User } from '@/lib/types';
import { drawBackground, exportPng, fit, renderLive, renderScene, type LiveItem } from '@/lib/canvasDraw';
import { friendly, prepareFile } from '@/lib/mediaClient';
import { mediaIdsOf, validateMemoryPayload } from '@couples/media-core';

type CanvasMeta = { id: string; favorite: boolean; opCount: number; createdAt: string };
type WireOp = { seq: number; clientOpId: string; senderId: string; senderDeviceId: string; keyVersion: number; nonce: string; ciphertext: string; createdAt: string };
type UITool = Tool | 'text' | 'sticker';
type Props = { user: User; e2ee: E2EE; keyTick: number; keyVersion: number; partnerName: string; onKeysUpdated: () => void };
type Ack = { ok: boolean; error?: string; op?: WireOp } | null;

const COLORS = ['#db2777', '#7c3aed', '#2563eb', '#059669', '#f59e0b', '#111827', '#ffffff'];
const BG_COLORS = ['#fff7fb', '#f3e8ff', '#e0f2fe', '#fde7f3', '#ffffff', '#0b1030'];
const STICKER_ICONS: Record<Sticker, typeof Heart> = { heart: Heart, star: Star, flower: Flower2, arrow: MoveRight, spark: Sparkles };

function emitAck(s: Socket, evt: string, payload?: unknown, ms = 5000): Promise<Ack> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const cb = (r: Ack) => { clearTimeout(t); resolve(r); };
    if (payload === undefined) s.emit(evt, cb); else s.emit(evt, payload, cb);
  });
}

export default function LoveCanvas({ user, e2ee, keyTick, keyVersion, partnerName, onKeysUpdated }: Props) {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tool, setTool] = useState<UITool>('pen');
  const [color, setColor] = useState('#db2777');
  const [size, setSize] = useState(6);
  const [sticker, setSticker] = useState<Sticker>('heart');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [bg, setBg] = useState(DEFAULT_BG);
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [partnerDrawing, setPartnerDrawing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [cssW, setCssW] = useState(0);
  const [cssH, setCssH] = useState(0);
  const [textEdit, setTextEditState] = useState<{ x: number; y: number; sid: string; value: string } | null>(null);

  // Hot-path state lives in refs so pointer moves never trigger React renders.
  const wrapRef = useRef<HTMLDivElement>(null);
  const bgEl = useRef<HTMLCanvasElement>(null);
  const drawEl = useRef<HTMLCanvasElement>(null);
  const liveEl = useRef<HTMLCanvasElement>(null);
  const ctxs = useRef<{ bg: CanvasRenderingContext2D; draw: CanvasRenderingContext2D; live: CanvasRenderingContext2D } | null>(null);
  const dirty = useRef({ bg: true, scene: true, live: true });
  const wire = useRef(new Map<number, WireOp>());
  const decoded = useRef(new Map<number, Entry | 'locked' | 'bad'>());
  const pending = useRef(new Map<string, Entry>());
  const live = useRef(new Map<string, LiveItem>());
  const scene = useRef<Scene>({ visible: [], hidden: [], bg: DEFAULT_BG });
  const lastSeq = useRef(0);
  const redoStack = useRef<string[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const socketRef = useRef<Socket>();
  const joinRef = useRef<() => Promise<void>>();
  const partnerLive = useRef(0);
  const activeRef = useRef<string | null>(null);
  const prevActive = useRef<string | null>(null);
  const e2eeRef = useRef(e2ee);
  const kvRef = useRef(keyVersion);
  const onKeysRef = useRef(onKeysUpdated);
  const textRef = useRef<typeof textEdit>(null);
  const lastTextSend = useRef(0);
  const cur = useRef<{ sid: string; pts: number[]; sent: number; lastSend: number; tool: Tool; color: string; size: number } | null>(null);
  activeRef.current = activeId;
  e2eeRef.current = e2ee;
  kvRef.current = keyVersion;
  onKeysRef.current = onKeysUpdated;
  const setTE = (v: typeof textEdit) => { textRef.current = v; setTextEditState(v); };

  // ---------- scene ----------
  const recompute = useCallback(() => {
    const entries: Entry[] = [];
    decoded.current.forEach((v) => { if (typeof v === 'object') entries.push(v); });
    pending.current.forEach((v) => entries.push(v));
    scene.current = computeScene(entries);
    dirty.current.bg = dirty.current.scene = true;
    const mineHidden = new Set(hiddenIdsBy(scene.current, user.id));
    setCanUndo(undoCandidate(scene.current, user.id) !== null);
    setCanRedo(redoStack.current.some((id) => mineHidden.has(id)));
    setBg(scene.current.bg);
  }, [user.id]);

  const decodeOne = useCallback((canvasId: string, w: WireOp): Entry | 'locked' | 'bad' => {
    const r = e2eeRef.current.decryptCanvasOp(canvasId, w);
    if (r.state === 'locked') return 'locked';
    if (r.state === 'tampered') return 'bad';
    const op = validateOp(r.payload); // never trust a decrypted payload's shape
    return op ? { seq: w.seq, senderId: w.senderId, op } : 'bad';
  }, []);

  const ingest = useCallback((canvasId: string, ops: WireOp[]) => {
    if (ops.length === 0) return;
    for (const w of ops) {
      if (!wire.current.has(w.seq)) wire.current.set(w.seq, w);
      lastSeq.current = Math.max(lastSeq.current, w.seq);
      pending.current.delete(w.clientOpId);
      const had = decoded.current.get(w.seq);
      if (had === undefined || had === 'locked') decoded.current.set(w.seq, decodeOne(canvasId, w));
      const d = decoded.current.get(w.seq);
      if (typeof d === 'object' && (d.op.t === 'stroke' || d.op.t === 'text')) { live.current.delete(`${w.senderId}:${d.op.id}`); live.current.delete(`me:${d.op.id}`); }
    }
    dirty.current.live = true;
    recompute();
  }, [decodeOne, recompute]);

  const reset = useCallback(() => {
    wire.current.clear(); decoded.current.clear(); pending.current.clear(); live.current.clear();
    lastSeq.current = 0; redoStack.current = []; cur.current = null; setTE(null);
    recompute();
    dirty.current.live = true;
  }, [recompute]);

  const catchUp = useCallback(async (canvasId: string) => {
    for (let more = true; more;) {
      const r = await api<{ ops: WireOp[]; hasMore: boolean }>(`/canvases/${canvasId}/ops`, { query: { since: lastSeq.current, limit: 500 } });
      if (activeRef.current !== canvasId) return;
      ingest(canvasId, r.ops);
      more = r.hasMore && r.ops.length > 0;
    }
  }, [ingest]);

  // ---------- canvases list ----------
  const removeCanvas = useCallback((id: string) => {
    setCanvases((list) => list.filter((c) => c.id !== id));
    setActiveId((a) => (a === id ? null : a));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        let list = (await api<{ canvases: CanvasMeta[] }>('/canvases')).canvases;
        if (list.length === 0) list = [(await api<{ canvas: CanvasMeta }>('/canvases', { method: 'POST' })).canvas];
        setCanvases(list);
        setActiveId(list[list.length - 1].id);
      } catch { setErr('Could not load your canvases.'); }
    })();
  }, []);
  useEffect(() => { if (!activeId && canvases.length) setActiveId(canvases[canvases.length - 1].id); }, [activeId, canvases]);

  // ---------- socket ----------
  useEffect(() => {
    const s = connectSocket();
    socketRef.current = s;
    joinRef.current = async () => {
      const id = activeRef.current;
      if (!id || !s.connected) return;
      if (!(await emitAck(s, 'couple:join'))?.ok) { setConn('offline'); return; }
      const j = await emitAck(s, 'canvas:join', { canvasId: id });
      if (!j?.ok) { setConn('offline'); return; }
      setConn('online');
      await catchUp(id).catch(() => setErr('Could not load the drawing.'));
    };
    s.on('connect', () => { joinRef.current?.(); });
    s.on('disconnect', () => setConn('offline'));
    s.on('connect_error', async (e: Error) => { setConn('offline'); if (e.message === 'unauthorized') await tryRefresh(); });
    s.on('canvas:op', (m: { canvasId: string; op: WireOp }) => { if (m.canvasId === activeRef.current) ingest(m.canvasId, [m.op]); });
    s.on('canvas:archived', (m: { canvasId: string }) => removeCanvas(m.canvasId));
    s.on('canvas:created', () => { api<{ canvases: CanvasMeta[] }>('/canvases').then((r) => setCanvases(r.canvases)).catch(() => {}); });
    s.on('keys:updated', () => onKeysRef.current());
    s.on('canvas:live', (m: { canvasId: string; senderId: string; keyVersion: number; nonce: string; ciphertext: string }) => {
      if (m.canvasId !== activeRef.current || m.senderId === user.id) return;
      const p = validateLive(e2eeRef.current.decryptLive(m.canvasId, m.senderId, m.keyVersion, m));
      if (!p) return;
      const key = `${m.senderId}:${p.sid}`;
      partnerLive.current = Date.now();
      if (p.k === 'text') {
        if (p.text === '') live.current.delete(key);
        else live.current.set(key, { sid: p.sid, senderId: m.senderId, k: 'text', lastAt: Date.now(), color: p.color, size: p.size, text: p.text, x: p.x, y: p.y });
      } else {
        const prev = live.current.get(key);
        if (p.start || !prev || !prev.pts) live.current.set(key, { sid: p.sid, senderId: m.senderId, k: 'stroke', lastAt: Date.now(), color: p.color, size: p.size, tool: p.tool, pts: [...p.pts] });
        else { prev.pts.push(...p.pts); prev.lastAt = Date.now(); if (prev.pts.length > 3200) prev.pts.splice(0, prev.pts.length - 3200); }
      }
      dirty.current.live = true;
    });
    const timer = setInterval(() => {
      const now = Date.now();
      live.current.forEach((v, k) => { if (!k.startsWith('me:') && now - v.lastAt > 6000) { live.current.delete(k); dirty.current.live = true; } });
      setPartnerDrawing(now - partnerLive.current < 1500);
    }, 400);
    return () => { clearInterval(timer); s.removeAllListeners(); s.disconnect(); };
  }, [user.id, catchUp, ingest, removeCanvas]);

  // switching canvases: leave the old room, wipe local state, join + replay the new one
  useEffect(() => {
    const s = socketRef.current;
    if (prevActive.current && prevActive.current !== activeId) s?.emit('canvas:leave', { canvasId: prevActive.current });
    prevActive.current = activeId;
    reset();
    if (activeId) joinRef.current?.();
  }, [activeId, reset]);

  // keys arrived later (approval, rotation): retry anything that was locked
  useEffect(() => {
    const id = activeRef.current;
    if (!id) return;
    let changed = false;
    wire.current.forEach((w, seq) => { if (decoded.current.get(seq) === 'locked') { decoded.current.set(seq, decodeOne(id, w)); changed = true; } });
    if (changed) recompute();
  }, [keyTick, decodeOne, recompute]);

  // ---------- layout + paint loop ----------
  useEffect(() => {
    const layout = () => {
      const wrap = wrapRef.current;
      if (!wrap || !bgEl.current || !drawEl.current || !liveEl.current) return;
      const w = Math.min(Math.floor(wrap.clientWidth), Math.floor(window.innerHeight * 9 / 16));
      const h = Math.floor(w * 16 / 9);
      if (w < 50) return; // hidden tab
      ctxs.current = { bg: fit(bgEl.current, w, h), draw: fit(drawEl.current, w, h), live: fit(liveEl.current, w, h) };
      setCssW(w);
      setCssH(h);
      dirty.current = { bg: true, scene: true, live: true };
    };
    layout();
    const ro = new ResizeObserver(layout);
    if (wrapRef.current) ro.observe(wrapRef.current);
    let raf = 0;
    const tick = () => {
      const c = ctxs.current;
      const d = dirty.current;
      if (c) {
        if (d.bg) { drawBackground(c.bg, scene.current.bg); d.bg = false; }
        if (d.scene) { renderScene(c.draw, scene.current); d.scene = false; }
        if (d.live) { renderLive(c.live, live.current.values()); d.live = false; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  // ---------- sending ----------
  const fail = useCallback((clientOpId: string, msg: string) => { pending.current.delete(clientOpId); recompute(); setErr(msg); }, [recompute]);

  const post = useCallback(async (canvasId: string, body: ReturnType<E2EE['buildCanvasOp']>) => {
    const s = socketRef.current;
    let res: Ack = null;
    if (s?.connected) res = await emitAck(s, 'canvas:op', body, 6000);
    if (res?.ok && res.op) { ingest(canvasId, [res.op]); return; }
    if (res?.error === 'KEY_VERSION_STALE') { fail(body.clientOpId, 'Your partner’s keys changed. Updating…'); onKeysRef.current(); return; }
    try {
      const r = await api<{ op: WireOp }>(`/canvases/${canvasId}/ops`, { method: 'POST', body: { clientOpId: body.clientOpId, deviceId: body.deviceId, keyVersion: body.keyVersion, nonce: body.nonce, ciphertext: body.ciphertext } });
      ingest(canvasId, [r.op]);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'KEY_VERSION_STALE') onKeysRef.current();
      fail(body.clientOpId, e instanceof ApiError && e.code === 'CANVAS_FULL' ? 'This canvas is full. Start a new one.' : 'Could not save that change.');
    }
  }, [ingest, fail]);

  const sendOp = useCallback((payload: Op, id?: string) => {
    const canvasId = activeRef.current;
    if (!canvasId) return;
    let body: ReturnType<E2EE['buildCanvasOp']>;
    try { body = e2eeRef.current.buildCanvasOp(user.id, canvasId, kvRef.current, payload, id); }
    catch { setErr('Your device doesn’t have the current key yet.'); return; }
    if (payload.t !== 'undo' && payload.t !== 'redo') redoStack.current = [];
    pending.current.set(body.clientOpId, { seq: Infinity, senderId: user.id, op: payload });
    recompute();
    queue.current = queue.current.then(() => post(canvasId, body)); // strictly ordered per client
  }, [user.id, recompute, post]);

  const sendLive = useCallback((payload: unknown) => {
    const s = socketRef.current;
    const id = activeRef.current;
    if (!s?.connected || !id) return;
    try { s.volatile.emit('canvas:live', e2eeRef.current.buildLive(user.id, id, kvRef.current, payload)); } catch { /* no key yet */ }
  }, [user.id]);

  // ---------- pointer handling ----------
  const toLogical = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = liveEl.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const flushLive = (c: NonNullable<typeof cur.current>, start: boolean) => {
    let pts = c.pts.slice(Math.max(0, c.sent - 2));
    if (pts.length > 398) pts = pts.slice(-398);
    c.sent = c.pts.length;
    sendLive({ k: 'stroke', sid: c.sid, tool: c.tool, color: c.color, size: c.size, pts, start });
  };
  const showLocal = (c: NonNullable<typeof cur.current>) => {
    live.current.set(`me:${c.sid}`, { sid: c.sid, senderId: user.id, k: 'stroke', lastAt: Date.now(), color: c.color, size: c.size, tool: c.tool, pts: c.pts });
    dirty.current.live = true;
  };
  const commitStroke = (c: NonNullable<typeof cur.current>) => {
    live.current.delete(`me:${c.sid}`);
    sendOp({ t: 'stroke', id: c.sid, tool: c.tool, color: c.color, size: c.size, pts: c.pts }, c.sid);
  };
  const commitText = () => {
    const te = textRef.current;
    if (!te) return;
    setTE(null);
    sendLive({ k: 'text', sid: te.sid, text: '', x: te.x, y: te.y, color, size: 10 + size * 2 });
    const text = te.value.trim().slice(0, 280);
    if (text) sendOp({ t: 'text', id: te.sid, text, x: te.x, y: te.y, color, size: 10 + size * 2 }, te.sid);
  };

  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!activeId || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (textRef.current) { commitText(); return; }
    const [x, y] = toLogical(e);
    if (tool === 'text') { setTE({ x: Math.round(x), y: Math.round(y), sid: crypto.randomUUID(), value: '' }); return; }
    if (tool === 'sticker') { const id = crypto.randomUUID(); sendOp({ t: 'sticker', id, kind: sticker, x: Math.round(x), y: Math.round(y), color, size: 24 + size * 4, rot: 0 }, id); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    const c = { sid: crypto.randomUUID(), pts: [Math.round(x), Math.round(y)], sent: 0, lastSend: 0, tool, color, size };
    cur.current = c;
    showLocal(c);
    flushLive(c, true);
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    let c = cur.current;
    if (!c) return;
    const native = e.nativeEvent;
    const evs = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [native]) {
      const [x, y] = toLogical(ev);
      const lx = c.pts[c.pts.length - 2], ly = c.pts[c.pts.length - 1];
      if (Math.hypot(x - lx, y - ly) < 1.5) continue;
      c.pts.push(Math.round(x), Math.round(y));
      if (c.pts.length >= 2800) { // very long stroke: commit this chunk and continue seamlessly in a new one
        commitStroke(c);
        c = { ...c, sid: crypto.randomUUID(), pts: [Math.round(x), Math.round(y)], sent: 0 };
        cur.current = c;
        flushLive(c, true);
      }
    }
    showLocal(c);
    const now = performance.now();
    if (now - c.lastSend > 40) { c.lastSend = now; flushLive(c, false); }
  };
  const onUp = () => {
    const c = cur.current;
    cur.current = null;
    if (c) commitStroke(c);
  };

  // ---------- toolbar actions ----------
  const undo = () => { const id = undoCandidate(scene.current, user.id); if (!id) return; redoStack.current.push(id); sendOp({ t: 'undo', target: id }); };
  const redo = () => {
    const hidden = new Set(hiddenIdsBy(scene.current, user.id));
    while (redoStack.current.length) { const id = redoStack.current.pop()!; if (hidden.has(id)) { sendOp({ t: 'redo', target: id }); return; } }
  };
  const clearAll = () => { if (confirm('Clear the whole canvas for both of you?')) sendOp({ t: 'clear' }); };
  const newCanvas = async () => {
    try { const c = (await api<{ canvas: CanvasMeta }>('/canvases', { method: 'POST' })).canvas; setCanvases((l) => [...l, c]); setActiveId(c.id); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Could not create a canvas.'); }
  };
  const deleteCanvas = async () => {
    if (!activeId || !confirm('Delete this canvas for both of you?')) return;
    await api(`/canvases/${activeId}`, { method: 'DELETE' }).catch(() => setErr('Could not delete the canvas.'));
  };
  const toggleFavorite = async () => {
    const c = canvases.find((x) => x.id === activeId);
    if (!c) return;
    try {
      const r = await api<{ canvas: CanvasMeta }>(`/canvases/${c.id}`, { method: 'PATCH', body: { favorite: !c.favorite } });
      setCanvases((l) => l.map((x) => (x.id === c.id ? r.canvas : x)));
    } catch { setErr('Could not update favorite.'); }
  };
  const download = async () => {
    const blob = await exportPng(scene.current);
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'our-drawing.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const saveToMemories = async () => {
    if (!activeId) return;
    setErr(null); setInfo('Saving to Our Memories…');
    try {
      const png = await exportPng(scene.current);
      if (!png) throw new Error('Could not export the drawing.');
      const media = await prepareFile(png, { name: 'our-drawing.png' });
      const payload = validateMemoryPayload({ v: 1, title: 'Our drawing', media: [media] }, 'drawing');
      if (!payload) throw new Error('Could not save the drawing.');
      const body = e2eeRef.current.buildMemory(user.id, 'drawing', kvRef.current, payload);
      await api('/memories', { method: 'POST', body: { ...body, eventDate: new Date().toISOString().slice(0, 10), canvasId: activeId, mediaIds: mediaIdsOf(payload.media) } });
      setInfo('Saved to Our Memories ♥');
      setTimeout(() => setInfo(null), 3000);
    } catch (e) { setInfo(null); setErr(friendly(e)); }
  };

  const active = canvases.find((c) => c.id === activeId);
  const toolBtn = (t: UITool, Icon: typeof Heart, label: string) => (
    <button key={t} className={`btn-ghost px-3 ${tool === t ? 'border-accent2 bg-accent2/20' : ''}`} aria-label={label} aria-pressed={tool === t} onClick={() => setTool(t)}><Icon className="h-4 w-4" /></button>
  );
  const textScale = cssW / W;

  return (
    <section className="w-full px-3 pb-6 sm:px-6 lg:px-10" aria-label="Live Love Canvas">
      <div className="flex flex-wrap items-center gap-2 py-2">
        <label className="sr-only" htmlFor="canvas-select">Choose canvas</label>
        <select id="canvas-select" className="input w-auto py-2" value={activeId ?? ''} onChange={(e) => setActiveId(e.target.value)}>
          {canvases.map((c, i) => <option key={c.id} value={c.id}>{c.favorite ? '★ ' : ''}Canvas {i + 1}</option>)}
        </select>
        <button className="btn-ghost" aria-label="New canvas" onClick={newCanvas}><Plus className="h-4 w-4" /></button>
        <button className="btn-ghost" aria-label={active?.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={!!active?.favorite} onClick={toggleFavorite}><Bookmark className={`h-4 w-4 ${active?.favorite ? 'fill-accent text-accent' : ''}`} /></button>
        <button className="btn-ghost" aria-label="Download as PNG" onClick={download}><Download className="h-4 w-4" /></button>
        <button className="btn-ghost" onClick={saveToMemories}><Heart className="h-4 w-4 text-accent" aria-hidden />Save to Memories</button>
        <button className="btn-ghost" aria-label="Delete canvas" onClick={deleteCanvas}><Trash2 className="h-4 w-4" /></button>
        <p className="ml-auto text-xs text-muted" aria-live="polite">{partnerDrawing ? `💜 ${partnerName} is drawing…` : conn !== 'online' ? conn : 'end-to-end encrypted'}</p>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-2" role="toolbar" aria-label="Drawing tools">
        {toolBtn('pen', PenLine, 'Pencil')}
        {toolBtn('brush', Brush, 'Brush')}
        {toolBtn('eraser', Eraser, 'Eraser')}
        {toolBtn('text', Type, 'Write text')}
        {(Object.keys(STICKER_ICONS) as Sticker[]).map((k) => {
          const Icon = STICKER_ICONS[k];
          return <button key={k} className={`btn-ghost px-3 ${tool === 'sticker' && sticker === k ? 'border-accent2 bg-accent2/20' : ''}`} aria-label={`Sticker: ${k}`} aria-pressed={tool === 'sticker' && sticker === k} onClick={() => { setTool('sticker'); setSticker(k); }}><Icon className="h-4 w-4" /></button>;
        })}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden />
        <button className="btn-ghost px-3" aria-label="Undo" disabled={!canUndo} onClick={undo}><Undo2 className="h-4 w-4" /></button>
        <button className="btn-ghost px-3" aria-label="Redo" disabled={!canRedo} onClick={redo}><Redo2 className="h-4 w-4" /></button>
        <button className="btn-ghost" onClick={clearAll}>Clear</button>
      </div>

      <div className="flex flex-wrap items-center gap-3 pb-2">
        <div className="flex items-center gap-1" role="group" aria-label="Colour">
          {COLORS.map((c) => <button key={c} aria-label={`Colour ${c}`} aria-pressed={color === c} className={`h-7 w-7 rounded-full border ${color === c ? 'ring-2 ring-accent2' : 'border-line'}`} style={{ background: c }} onClick={() => setColor(c)} />)}
          <input type="color" aria-label="Custom colour" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">Size
          <input type="range" min={2} max={40} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="Background">
          {BG_COLORS.map((c) => <button key={c} aria-label={`Background ${c}`} aria-pressed={bg.color === c} className={`h-6 w-6 rounded-md border ${bg.color === c ? 'ring-2 ring-accent2' : 'border-line'}`} style={{ background: c }} onClick={() => sendOp({ t: 'bg', color: c, pattern: bg.pattern })} />)}
          <select aria-label="Background pattern" className="input w-auto py-1 text-sm" value={bg.pattern} onChange={(e) => sendOp({ t: 'bg', color: bg.color, pattern: e.target.value })}>
            {PATTERNS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      {info && <p role="status" className="mb-2 text-sm text-accent2">{info}</p>}
      {err && <p role="alert" className="mb-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err} <button className="underline" onClick={() => setErr(null)}>dismiss</button></p>}

      <div ref={wrapRef} className="w-full">
        <div className="relative mx-auto overflow-hidden rounded-3xl border border-line shadow-soft" style={{ width: cssW || '100%', height: cssH || undefined, aspectRatio: cssW ? undefined : '9 / 16' }}>
          <canvas ref={bgEl} className="absolute inset-0" aria-hidden />
          <canvas ref={drawEl} className="absolute inset-0" aria-hidden />
          <canvas
            ref={liveEl}
            className="absolute inset-0 cursor-crosshair"
            style={{ touchAction: 'none' }}
            role="img"
            aria-label="Shared drawing canvas. Draw with a mouse, finger or stylus."
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          />
          {textEdit && (
            <textarea
              autoFocus
              aria-label="Type your message on the canvas"
              className="absolute resize-none overflow-hidden border border-dashed border-accent2 bg-transparent p-0 leading-tight outline-none"
              style={{ left: (textEdit.x / W) * cssW, top: (textEdit.y / H) * cssH, color, fontSize: (10 + size * 2) * textScale, width: Math.max(120, cssW - (textEdit.x / W) * cssW - 12), height: (10 + size * 2) * textScale * 3.2 }}
              value={textEdit.value}
              maxLength={280}
              onChange={(e) => {
                const value = e.target.value;
                const te = { ...textEdit, value };
                setTE(te);
                const now = Date.now();
                if (now - lastTextSend.current > 150) { lastTextSend.current = now; sendLive({ k: 'text', sid: te.sid, text: value, x: te.x, y: te.y, color, size: 10 + size * 2 }); }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
                if (e.key === 'Escape') { sendLive({ k: 'text', sid: textEdit.sid, text: '', x: textEdit.x, y: textEdit.y, color, size: 10 + size * 2 }); setTE(null); }
              }}
              onBlur={commitText}
            />
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-muted">Tip: pick the text tool, tap the canvas and type. {partnerName} sees it appear as you write. Press Enter to place it.</p>
    </section>
  );
}
