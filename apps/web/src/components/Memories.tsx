'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes, groupByMonth, kindForMime, matchesQuery, mediaIdsOf, validateMemoryPayload,
  type Descriptor, type MemoryPayload, type MemoryType,
} from '@couples/media-core';
import { Plus, Search, Star, Trash2, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { E2EE } from '@/lib/e2ee';
import type { User } from '@/lib/types';
import { MediaError, friendly, prepareFile, startRecording, type Recording } from '@/lib/mediaClient';
import MediaView from './MediaView';

type Wire = {
  id: string; createdBy: string; clientMemoryId: string; type: MemoryType; eventDate: string; albumId: string | null; mediaIds: string[];
  canvasId: string | null; favorite: boolean; downloadLocked: boolean; keyVersion: number; nonce: string; ciphertext: string;
};
type WireAlbum = { id: string; createdBy: string; clientAlbumId: string; keyVersion: number; nonce: string; ciphertext: string };
type Item = Wire & { payload: MemoryPayload | null; state: 'ok' | 'locked' | 'tampered' };
type Props = { user: User; e2ee: E2EE; keyTick: number; keyVersion: number; visible: boolean };

const TYPES: { id: MemoryType; label: string; emoji: string }[] = [
  { id: 'photo', label: 'Photos', emoji: '📷' }, { id: 'video', label: 'Videos', emoji: '🎬' }, { id: 'voice', label: 'Voice', emoji: '🎙️' },
  { id: 'drawing', label: 'Drawings', emoji: '🎨' }, { id: 'message', label: 'Messages', emoji: '💬' }, { id: 'note', label: 'Notes', emoji: '📝' },
  { id: 'letter', label: 'Letters', emoji: '💌' }, { id: 'date', label: 'Dates', emoji: '📅' },
];
const emojiOf = (t: MemoryType) => TYPES.find((x) => x.id === t)?.emoji ?? '♥';
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const fmtMonth = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', year: 'numeric' });
const today = () => new Date().toISOString().slice(0, 10);

export default function Memories({ user, e2ee, keyTick, keyVersion, visible }: Props) {
  const [raw, setRaw] = useState<Wire[]>([]);
  const [albumsRaw, setAlbumsRaw] = useState<WireAlbum[]>([]);
  const [typeFilter, setTypeFilter] = useState<MemoryType | ''>('');
  const [favOnly, setFavOnly] = useState(false);
  const [albumFilter, setAlbumFilter] = useState('');
  const [query, setQuery] = useState('');
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++loadSeq.current;
    try {
      const all: Wire[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 30; page++) { // search is client-side, so we fetch (and decrypt) the whole timeline
        const r: { memories: Wire[]; nextCursor: string | null } = await api<{ memories: Wire[]; nextCursor: string | null }>('/memories', {
          query: { limit: 100, before: cursor, type: typeFilter || undefined, favorite: favOnly ? 'true' : undefined, albumId: albumFilter || undefined },
        });
        all.push(...r.memories);
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      if (mine !== loadSeq.current) return; // a newer load superseded this one
      setRaw(all); setMore(Boolean(cursor));
      setAlbumsRaw((await api<{ albums: WireAlbum[] }>('/memories/albums')).albums);
      setUsage(await api<{ used: number; quota: number }>('/media/usage'));
      setErr(null);
    } catch (e) { if (mine === loadSeq.current) setErr(e instanceof ApiError ? e.message : 'Could not load memories.'); }
    finally { if (mine === loadSeq.current) setLoading(false); }
  }, [typeFilter, favOnly, albumFilter]);

  useEffect(() => {
    if (!visible) return;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [visible, load]);

  const items: Item[] = useMemo(() => {
    void keyTick; // re-decrypt when new keys arrive
    return raw.map((w) => {
      const r = e2ee.decryptMemory(w);
      if (r.state !== 'ok') return { ...w, payload: null, state: r.state };
      const p = validateMemoryPayload(r.payload, w.type);
      return p ? { ...w, payload: p, state: 'ok' as const } : { ...w, payload: null, state: 'tampered' as const };
    });
  }, [raw, keyTick, e2ee]);

  const albums = useMemo(() => {
    void keyTick;
    return albumsRaw.map((a) => ({ id: a.id, raw: a, name: e2ee.decryptAlbumName(a) ?? 'Album' }));
  }, [albumsRaw, keyTick, e2ee]);

  const shown = useMemo(
    () => items.filter((i) => !query.trim() || (i.payload && matchesQuery([i.payload.title, i.payload.caption, i.payload.text, i.payload.from], query))),
    [items, query]
  );
  const months = useMemo(() => groupByMonth(shown, (i) => i.eventDate), [shown]);

  async function act(fn: () => Promise<void>) {
    setErr(null);
    try { await fn(); } catch (e) { setErr(friendly(e)); }
  }
  const toggleFav = (i: Item) => act(async () => {
    const r = await api<{ memory: Wire }>(`/memories/${i.id}/favorite`, { method: 'PUT', body: { favorite: !i.favorite } });
    setRaw((l) => l.map((w) => (w.id === i.id ? { ...w, favorite: r.memory.favorite } : w)));
  });
  const moveTo = (i: Item, albumId: string) => act(async () => {
    const r = await api<{ memory: Wire }>(`/memories/${i.id}`, { method: 'PATCH', body: { albumId: albumId || null } });
    setRaw((l) => l.map((w) => (w.id === i.id ? { ...w, albumId: r.memory.albumId } : w)));
  });
  const remove = (i: Item) => {
    if (!confirm('Delete this memory for both of you? Photos and recordings only used here are permanently removed.')) return;
    void act(async () => { await api(`/memories/${i.id}`, { method: 'DELETE' }); setRaw((l) => l.filter((w) => w.id !== i.id)); setUsage(await api<{ used: number; quota: number }>('/media/usage')); });
  };
  const newAlbum = () => {
    const name = prompt('Album name')?.trim();
    if (!name) return;
    void act(async () => { await api('/memories/albums', { method: 'POST', body: e2ee.buildAlbum(user.id, keyVersion, name) }); await load(); });
  };
  const renameAlbum = () => {
    const a = albums.find((x) => x.id === albumFilter);
    const name = a && prompt('Rename album', a.name)?.trim();
    if (!a || !name) return;
    void act(async () => { await api(`/memories/albums/${a.id}`, { method: 'PATCH', body: e2ee.buildAlbumRename(a.raw.createdBy, a.raw.clientAlbumId, keyVersion, name) }); await load(); });
  };
  const deleteAlbum = () => {
    if (!albumFilter || !confirm('Delete this album? Its memories are kept, just unfiled.')) return;
    void act(async () => { await api(`/memories/albums/${albumFilter}`, { method: 'DELETE' }); setAlbumFilter(''); });
  };

  const pct = usage ? Math.min(100, Math.round((usage.used / usage.quota) * 100)) : 0;

  return (
    <section className="w-full px-3 pb-10 sm:px-6 lg:px-10" aria-label="Our Memories">
      <div className="flex flex-wrap items-center gap-2 py-3">
        <h2 className="text-lg font-semibold">Our Memories</h2>
        <button className="btn-primary ml-auto" onClick={() => setAdding(true)}><Plus className="h-4 w-4" aria-hidden />Add memory</button>
      </div>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted" aria-hidden />
        <label className="sr-only" htmlFor="mem-search">Search memories</label>
        <input id="mem-search" className="input pl-9" placeholder="Search titles, captions and letters…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Filter memories">
        <button className={`btn-ghost px-3 py-1.5 text-sm ${!typeFilter && !favOnly ? 'border-accent2 bg-accent2/20' : ''}`} aria-pressed={!typeFilter && !favOnly} onClick={() => { setTypeFilter(''); setFavOnly(false); }}>All</button>
        <button className={`btn-ghost px-3 py-1.5 text-sm ${favOnly ? 'border-accent2 bg-accent2/20' : ''}`} aria-pressed={favOnly} onClick={() => setFavOnly((v) => !v)}>★ Favorites</button>
        {TYPES.map((t) => (
          <button key={t.id} className={`btn-ghost px-3 py-1.5 text-sm ${typeFilter === t.id ? 'border-accent2 bg-accent2/20' : ''}`} aria-pressed={typeFilter === t.id} onClick={() => setTypeFilter(typeFilter === t.id ? '' : t.id)}>{t.emoji} {t.label}</button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="album-filter">Album</label>
        <select id="album-filter" className="input w-auto py-1.5 text-sm" value={albumFilter} onChange={(e) => setAlbumFilter(e.target.value)}>
          <option value="">All albums</option>
          {albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn-ghost px-3 py-1.5 text-sm" onClick={newAlbum}>New album</button>
        {albumFilter && <button className="btn-ghost px-3 py-1.5 text-sm" onClick={renameAlbum}>Rename</button>}
        {albumFilter && <button className="btn-ghost px-3 py-1.5 text-sm" onClick={deleteAlbum}>Delete album</button>}
        {usage && (
          <div className="ml-auto min-w-[140px] text-xs text-muted" aria-label="Storage used">
            <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full bg-gradient-to-r from-accent to-accent2" style={{ width: `${pct}%` }} /></div>
            {formatBytes(usage.used)} of {formatBytes(usage.quota)}
          </div>
        )}
      </div>

      {err && <p role="alert" className="mb-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
      {loading && <p className="py-10 text-center text-muted">Loading your memories…</p>}
      {!loading && shown.length === 0 && (
        <p className="py-10 text-center text-muted">{raw.length ? 'Nothing matches your search.' : 'No memories yet. Add a photo, a letter, a special date, or save something from your chat 💜'}</p>
      )}
      {more && <p className="mb-2 text-center text-xs text-muted">Showing your most recent memories. Narrow the filters to see older ones.</p>}

      {months.map((g) => (
        <div key={`${g.key}-${g.items[0].id}`} className="mb-6">
          <h3 className="sticky top-0 z-10 bg-bg/80 py-1 text-sm font-medium text-muted backdrop-blur">{fmtMonth(g.key)}</h3>
          <ul className="grid gap-3">
            {g.items.map((i) => (
              <li key={i.id} className="card">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <span>{emojiOf(i.type)} {fmtDate(i.eventDate)}</span>
                  {i.albumId && <span className="rounded-full bg-accent2/15 px-2">{albums.find((a) => a.id === i.albumId)?.name ?? 'Album'}</span>}
                  <span className="ml-auto flex items-center gap-1">
                    <button className="btn-ghost px-2 py-1" aria-label={i.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={i.favorite} onClick={() => toggleFav(i)}><Star className={`h-4 w-4 ${i.favorite ? 'fill-accent text-accent' : ''}`} /></button>
                    <button className="btn-ghost px-2 py-1" aria-label="Delete memory" onClick={() => remove(i)}><Trash2 className="h-4 w-4" /></button>
                  </span>
                </div>
                {i.state === 'locked' && <p className="italic text-muted">Waiting for the key…</p>}
                {i.state === 'tampered' && <p className="italic text-red-500">Couldn’t verify this memory.</p>}
                {i.payload && (
                  <>
                    {i.payload.title && <h4 className="font-medium">{i.payload.title}</h4>}
                    {i.payload.media?.map((d: Descriptor) => <MediaView key={d.id} desc={d} canDownload={!i.downloadLocked} />)}
                    {i.payload.text && <p className="my-1 whitespace-pre-wrap break-words">{i.payload.text}</p>}
                    {i.payload.caption && <p className="text-sm text-muted">{i.payload.caption}</p>}
                    {i.payload.from && <p className="mt-1 text-xs text-muted">— {i.payload.from}</p>}
                  </>
                )}
                {albums.length > 0 && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted">Album
                    <select className="input w-auto py-1 text-xs" value={i.albumId ?? ''} onChange={(e) => moveTo(i, e.target.value)}>
                      <option value="">None</option>
                      {albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </label>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {adding && <NewMemory user={user} e2ee={e2ee} keyVersion={keyVersion} albums={albums} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); void load(); }} />}
    </section>
  );
}

// ---------- add a memory ----------
type CreatableType = 'photo' | 'video' | 'voice' | 'letter' | 'note' | 'date';
const CREATABLE: { id: CreatableType; label: string }[] = [
  { id: 'photo', label: '📷 Photo' }, { id: 'video', label: '🎬 Video' }, { id: 'voice', label: '🎙️ Voice note' },
  { id: 'letter', label: '💌 Love letter' }, { id: 'note', label: '📝 Note' }, { id: 'date', label: '📅 Special date' },
];
const ACCEPT: Partial<Record<CreatableType, string>> = { photo: 'image/jpeg,image/png,image/webp,image/gif', video: 'video/mp4,video/webm', voice: 'audio/*' };
const EXPECT = { photo: 'image', video: 'video', voice: 'audio' } as const;

function NewMemory({ user, e2ee, keyVersion, albums, onClose, onCreated }: {
  user: User; e2ee: E2EE; keyVersion: number; albums: { id: string; name: string }[]; onClose: () => void; onCreated: () => void;
}) {
  const [type, setType] = useState<CreatableType>('photo');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [text, setText] = useState('');
  const [date, setDate] = useState(today());
  const [albumId, setAlbumId] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [voice, setVoice] = useState<{ blob: Blob; seconds: number } | null>(null);
  const [recSeconds, setRecSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const rec = useRef<Recording | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>();
  useEffect(() => () => { clearInterval(timer.current); rec.current?.cancel(); }, []);

  const needsFile = type === 'photo' || type === 'video' || type === 'voice';
  const needsText = type === 'letter' || type === 'note';

  async function toggleRecord() {
    setErr(null);
    if (rec.current) {
      clearInterval(timer.current);
      const r = rec.current; rec.current = null; setRecSeconds(null);
      setVoice(await r.stop());
      return;
    }
    try {
      rec.current = await startRecording(300, () => { void toggleRecord(); });
      const t0 = Date.now(); setVoice(null); setRecSeconds(0);
      timer.current = setInterval(() => setRecSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    } catch (e) { setErr(friendly(e)); }
  }

  async function submit() {
    setErr(null); setBusy(true); setProgress(0);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      let media: Descriptor[] | undefined;
      if (needsFile) {
        const src: Blob | null = type === 'voice' ? (voice?.blob ?? file) : file;
        if (!src) throw new MediaError('UNSUPPORTED', type === 'voice' ? 'Record a voice note or choose an audio file.' : 'Choose a file first.');
        const d = await prepareFile(src, { name: file?.name, durOverride: voice?.seconds, voice: type === 'voice', signal: ctrl.signal, onProgress: setProgress });
        const want = EXPECT[type as 'photo' | 'video' | 'voice'];
        if (kindForMime(d.mime) !== want) throw new MediaError('UNSUPPORTED', `That file isn’t a ${want === 'audio' ? 'sound' : want}.`);
        media = [d];
      }
      const payload = validateMemoryPayload({ v: 1, title: title.trim() || undefined, caption: caption.trim() || undefined, text: text.trim() || undefined, media }, type);
      if (!payload) throw new MediaError('UNSUPPORTED', needsText ? 'Please write something first.' : type === 'date' ? 'Give this date a title.' : 'Please check the fields.');
      const body = e2ee.buildMemory(user.id, type, keyVersion, payload);
      await api('/memories', { method: 'POST', body: { ...body, eventDate: date, mediaIds: mediaIdsOf(media), albumId: albumId || undefined, downloadLocked: !allowDownload } });
      onCreated();
    } catch (e) {
      if (!(e instanceof MediaError && e.code === 'CANCELLED')) setErr(friendly(e));
    } finally { setBusy(false); abort.current = null; }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="newmem-h" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4">
      <div className="card grid w-full max-w-md gap-3">
        <div className="flex items-center justify-between">
          <h2 id="newmem-h" className="text-lg font-semibold">Add a memory</h2>
          <button className="btn-ghost px-2 py-1" aria-label="Close" onClick={() => { abort.current?.abort(); onClose(); }}><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Memory type">
          {CREATABLE.map((t) => <button key={t.id} className={`btn-ghost px-3 py-1.5 text-sm ${type === t.id ? 'border-accent2 bg-accent2/20' : ''}`} aria-pressed={type === t.id} onClick={() => { setType(t.id); setFile(null); setVoice(null); }}>{t.label}</button>)}
        </div>
        <div><label className="label" htmlFor="nm-title">Title{type === 'date' ? '' : ' (optional)'}</label>
          <input id="nm-title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        {needsFile && (
          <div>
            <label className="label" htmlFor="nm-file">{type === 'voice' ? 'Audio file (or record below)' : 'File'}</label>
            <input id="nm-file" type="file" accept={ACCEPT[type]} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setVoice(null); }} />
            {type === 'voice' && (
              <button type="button" className={`btn-ghost mt-2 ${recSeconds !== null ? 'border-red-500 text-red-500' : ''}`} onClick={toggleRecord}>
                {recSeconds !== null ? `■ Stop (${recSeconds}s)` : voice ? `🎙️ Re-record (${voice.seconds}s recorded)` : '🎙️ Record'}
              </button>
            )}
          </div>
        )}
        {needsText && <div><label className="label" htmlFor="nm-text">{type === 'letter' ? 'Your letter' : 'Your note'}</label>
          <textarea id="nm-text" className="input min-h-[140px]" maxLength={20000} value={text} onChange={(e) => setText(e.target.value)} /></div>}
        {needsFile && <div><label className="label" htmlFor="nm-cap">Caption (optional)</label>
          <textarea id="nm-cap" className="input" rows={2} maxLength={2000} value={caption} onChange={(e) => setCaption(e.target.value)} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="nm-date">Date</label><input id="nm-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className="label" htmlFor="nm-album">Album</label>
            <select id="nm-album" className="input" value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
              <option value="">None</option>{albums.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
        </div>
        {needsFile && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} />Show a “save to device” button
          <span className="text-xs text-muted">(a courtesy setting; it can’t stop someone who can already open the file)</span></label>}
        {busy && needsFile && <p role="status" className="text-sm text-muted">Encrypting and uploading… {Math.round(progress * 100)}%</p>}
        {err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
        <div className="flex gap-2">
          <button className="btn-primary flex-1" disabled={busy || !date} onClick={submit}>{busy ? 'Saving…' : 'Save memory'}</button>
          {busy && <button className="btn-ghost" onClick={() => abort.current?.abort()}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}
