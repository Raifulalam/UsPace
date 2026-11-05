import * as cc from '@couples/crypto';
import { LIMITS, kindForMime, sniffMime, validateDescriptor, type Descriptor } from '@couples/media-core';
import { API_BASE, ApiError, api, getToken, tryRefresh } from './api';

export type MediaErrorCode = 'UNSUPPORTED' | 'TOO_LARGE' | 'UPLOAD_FAILED' | 'DOWNLOAD_FAILED' | 'CANCELLED' | 'QUOTA' | 'MIC';
export class MediaError extends Error {
  code: MediaErrorCode;
  constructor(code: MediaErrorCode, message: string) { super(message); this.code = code; }
}
export function friendly(e: unknown): string {
  if (e instanceof MediaError) return e.message;
  if (e instanceof ApiError) return e.code === 'KEY_VERSION_STALE' ? 'Your partner’s keys changed. Please try again in a moment.' : e.message;
  return e instanceof Error && e.message ? e.message : 'Something went wrong.';
}

type Hooks = { signal?: AbortSignal; onProgress?: (fraction: number) => void };
const MAX_SIDE = 4096;
const THUMB_SIDE = 320;

// ---------- upload ----------
function xhrPut(url: string, body: Blob, h: Hooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (h.signal?.aborted) return reject(new MediaError('CANCELLED', 'Upload cancelled'));
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    const t = getToken();
    if (t) xhr.setRequestHeader('Authorization', `Bearer ${t}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) h.onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(Object.assign(new Error(`HTTP ${xhr.status}`), { status: xhr.status })));
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }));
    xhr.onabort = () => reject(new MediaError('CANCELLED', 'Upload cancelled'));
    h.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function putWithRetry(url: string, body: Blob, h: Hooks) {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    try { return await xhrPut(url, body, h); }
    catch (e) {
      if (e instanceof MediaError) throw e;
      const status = (e as { status?: number }).status ?? 0;
      if (status === 401 && !refreshed) { refreshed = true; if (await tryRefresh()) continue; }
      // Retry only network blips, gateway errors, and the short window where the server is still resetting an interrupted upload.
      if (attempt >= 2 || ![0, 409, 502, 503, 504].includes(status)) throw new MediaError('UPLOAD_FAILED', 'Upload failed. Check your connection and try again.');
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/** Encrypts [plain] with [key], reserves space on the server, uploads the ciphertext and returns the asset id. */
async function uploadEncrypted(plain: Uint8Array, kind: 'image' | 'video' | 'audio' | 'thumb', key: Uint8Array, h: Hooks): Promise<string> {
  await cc.ready();
  const parts = cc.encryptFile(key, plain);
  const size = parts.reduce((n, p) => n + p.length, 0);
  let id: string;
  try { id = (await api<{ asset: { id: string } }>('/media', { method: 'POST', body: { kind, sizeBytes: size } })).asset.id; }
  catch (e) {
    if (e instanceof ApiError && e.code === 'QUOTA_EXCEEDED') throw new MediaError('QUOTA', 'Your shared storage is full. Delete something to make room.');
    throw e;
  }
  try { await putWithRetry(`${API_BASE}/api/v1/media/${id}/blob`, new Blob(parts as unknown as BlobPart[]), h); }
  catch (e) { await api(`/media/${id}`, { method: 'DELETE' }).catch(() => {}); throw e; } // free the reserved space right away
  return id;
}

// ---------- image / video preparation (all in the browser) ----------
function scaleTo(w: number, h: number, max: number) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
function toBytes(c: HTMLCanvasElement, type: string, q: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new MediaError('UNSUPPORTED', 'This image could not be processed.'))), type, q));
}
async function thumbFrom(src: CanvasImageSource, sw: number, sh: number): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const { w, h } = scaleTo(sw, sh, THUMB_SIDE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  return { bytes: await toBytes(c, 'image/jpeg', 0.72), w, h };
}
/** Re-drawing through a canvas drops EXIF data (location, camera, time) before the photo is shared. GIFs are kept as-is to stay animated. */
async function processImage(blob: Blob, mime: string, raw: Uint8Array) {
  const bmp = await createImageBitmap(blob).catch(() => { throw new MediaError('UNSUPPORTED', 'This image could not be opened.'); });
  try {
    const thumb = await thumbFrom(bmp, bmp.width, bmp.height).catch(() => undefined);
    if (mime === 'image/gif') return { bytes: raw, mime, w: bmp.width, h: bmp.height, thumb };
    const { w, h } = scaleTo(bmp.width, bmp.height, MAX_SIDE);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const outMime = mime === 'image/png' ? 'image/png' : 'image/jpeg';
    return { bytes: await toBytes(c, outMime, 0.92), mime: outMime, w, h, thumb };
  } finally { bmp.close(); }
}
const waitFor = (el: HTMLMediaElement, ev: string, ms: number) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('media error')); }, { once: true });
  });
async function probeVideo(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  try {
    await waitFor(v, 'loadedmetadata', 8000);
    const dur = Number.isFinite(v.duration) ? v.duration : undefined;
    v.currentTime = Math.min(1, (dur ?? 0) / 10);
    await waitFor(v, 'seeked', 8000);
    const w = v.videoWidth, h = v.videoHeight;
    return { w, h, dur, thumb: w && h ? await thumbFrom(v, w, h) : undefined };
  } catch { return {} as { w?: number; h?: number; dur?: number; thumb?: { bytes: Uint8Array; w: number; h: number } }; }
  finally { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); }
}
async function probeAudio(blob: Blob): Promise<number | undefined> {
  const url = URL.createObjectURL(blob);
  const a = new Audio();
  a.preload = 'metadata'; a.src = url;
  try { await waitFor(a, 'loadedmetadata', 5000); return Number.isFinite(a.duration) ? a.duration : undefined; }
  catch { return undefined; }
  finally { URL.revokeObjectURL(url); }
}

export type PrepareOptions = Hooks & { name?: string; durOverride?: number; voice?: boolean };

/** Validate by CONTENT, strip metadata, make a thumbnail, encrypt with a fresh key, upload. Returns the descriptor to embed in an encrypted message/memory. */
export async function prepareFile(file: Blob, o: PrepareOptions = {}): Promise<Descriptor> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffMime(raw, file.type);
  const kind = sniffed ? kindForMime(sniffed) : null;
  if (!sniffed || !kind) throw new MediaError('UNSUPPORTED', 'That file type isn’t supported. Use JPG, PNG, WebP, GIF, MP4, WebM or common audio.');
  if (raw.length > LIMITS[kind]) throw new MediaError('TOO_LARGE', `That file is too large (limit ${Math.round(LIMITS[kind] / 1048576)} MB).`);

  let bytes = raw, mime = sniffed;
  let meta: { w?: number; h?: number; dur?: number } = {};
  let thumb: { bytes: Uint8Array; w: number; h: number } | undefined;
  if (kind === 'image') { const r = await processImage(file, sniffed, raw); bytes = new Uint8Array(r.bytes); mime = r.mime; meta = { w: r.w, h: r.h }; thumb = r.thumb; }
  else if (kind === 'video') { const r = await probeVideo(file); meta = { w: r.w, h: r.h, dur: r.dur }; thumb = r.thumb; }
  else meta = { dur: o.durOverride ?? (await probeAudio(file)) };
  if (bytes.length > LIMITS[kind]) throw new MediaError('TOO_LARGE', 'That image is too large.');

  const key = cc.generateFileKey();
  const id = await uploadEncrypted(bytes, kind, key, o);

  let thumbDesc: Descriptor['thumb'];
  if (thumb && thumb.bytes.length <= LIMITS.thumb) {
    try {
      const tk = cc.generateFileKey();
      thumbDesc = { id: await uploadEncrypted(thumb.bytes, 'thumb', tk, { signal: o.signal }), key: cc.toBase64(tk), mime: 'image/jpeg', w: thumb.w, h: thumb.h };
    } catch { thumbDesc = undefined; } // a missing thumbnail is fine
  }
  const hasDims = meta.w && meta.h;
  const desc = validateDescriptor({
    id, key: cc.toBase64(key), mime, size: bytes.length, name: o.name,
    ...(hasDims ? { w: meta.w, h: meta.h } : {}), ...(meta.dur !== undefined ? { dur: meta.dur } : {}),
    ...(o.voice && kind === 'audio' ? { voice: true } : {}), ...(thumbDesc ? { thumb: thumbDesc } : {}),
  });
  if (!desc) throw new MediaError('UPLOAD_FAILED', 'Could not describe this file.');
  return desc;
}

// ---------- download + decrypt ----------
const cache = new Map<string, Promise<Blob>>();
type Fetchable = Pick<Descriptor, 'id' | 'key' | 'mime'>;

async function download(d: Fetchable, h: Hooks): Promise<Blob> {
  await cc.ready();
  const go = () => fetch(`${API_BASE}/api/v1/media/${d.id}/blob`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` }, signal: h.signal });
  let res = await go();
  if (res.status === 401 && (await tryRefresh())) res = await go();
  if (!res.ok || !res.body) throw new MediaError('DOWNLOAD_FAILED', 'Could not download this file.');
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) h.onProgress?.(got / total);
  }
  const data = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { data.set(c, off); off += c.length; }
  try { return new Blob(cc.decryptFile(cc.fromBase64(d.key), data) as unknown as BlobPart[], { type: d.mime }); }
  catch { throw new MediaError('DOWNLOAD_FAILED', 'This file failed its security check and was not opened.'); }
}

/** The type of the returned Blob comes from the validated descriptor (an allow-list), never from the server. Videos are not cached (memory). */
export function fetchDecrypted(d: Fetchable, h: Hooks = {}): Promise<Blob> {
  const cacheable = kindForMime(d.mime) !== 'video';
  const hit = cacheable ? cache.get(d.id) : undefined;
  if (hit) return hit;
  const p = download(d, h);
  if (cacheable) {
    cache.set(d.id, p);
    p.catch(() => cache.delete(d.id));
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  }
  return p;
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- voice notes ----------
export type Recording = { stop: () => Promise<{ blob: Blob; seconds: number }>; cancel: () => void };
const REC_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/** Asks for the microphone only when called (i.e. when the user taps record). */
export async function startRecording(maxSeconds = 300, onLimit?: () => void): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new MediaError('MIC', 'Voice notes aren’t supported in this browser.');
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { throw new MediaError('MIC', 'Microphone access was denied. You can allow it in your browser’s site settings and try again.'); }
  const mimeType = REC_MIMES.find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const t0 = Date.now();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const limit = setTimeout(() => { if (rec.state !== 'inactive') { onLimit?.(); } }, maxSeconds * 1000);
  rec.start();
  return {
    stop: () => new Promise((resolve) => {
      clearTimeout(limit);
      rec.onstop = () => { release(); resolve({ blob: new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] }), seconds: Math.round((Date.now() - t0) / 100) / 10 }); };
      rec.stop();
    }),
    cancel: () => { clearTimeout(limit); rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); release(); },
  };
}
