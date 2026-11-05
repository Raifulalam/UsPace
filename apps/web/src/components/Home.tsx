'use client';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Brush, Heart, Images, MessageCircle } from 'lucide-react';
import { TTL_OPTIONS, anniversaryInfo, formatRelative, hueOf, initialsOf, localTodayMs } from '@couples/space-core';
import { validateMemoryPayload, type MemoryPayload, type MemoryType } from '@couples/media-core';
import { api } from '@/lib/api';
import type { E2EE } from '@/lib/e2ee';
import type { ChatMessage, Couple, User, WireMessage } from '@/lib/types';
import { friendly } from '@/lib/mediaClient';
import MediaView from './MediaView';

type Props = {
  user: User; couple: Couple; e2ee: E2EE; keyTick: number; unread: number; visible: boolean;
  go: (view: 'chat' | 'canvas' | 'memories') => void; onCoupleChanged: () => void;
};
type FavWire = { id: string; createdBy: string; clientMemoryId: string; type: MemoryType; eventDate: string; keyVersion: number; nonce: string; ciphertext: string };
type Activity = { icon: string; text: string; at: number };

export function Avatar({ name, size = 56 }: { name: string; size?: number }) {
  const hue = hueOf(name);
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-soft" aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 75% 58%), hsl(${(hue + 50) % 360} 70% 50%))` }}>{initialsOf(name)}</span>
  );
}

const THEMES = [
  { id: 'rose', label: 'Rose', swatch: 'linear-gradient(135deg,#ec4899,#8b5cf6)' },
  { id: 'lavender', label: 'Lavender', swatch: 'linear-gradient(135deg,#a855f7,#6366f1)' },
  { id: 'midnight', label: 'Midnight', swatch: 'linear-gradient(135deg,#0b1030,#38bdf8)' },
] as const;

export default function Home({ user, couple, e2ee, keyTick, unread, visible, go, onCoupleChanged }: Props) {
  const me = couple.members.find((m) => m.id === user.id);
  const partner = couple.members.find((m) => m.id !== user.id);
  const myName = me?.displayName ?? user.displayName;
  const partnerName = partner?.displayName ?? partner?.username ?? 'Your partner';

  const [recent, setRecent] = useState<WireMessage[]>([]);
  const [favs, setFavs] = useState<FavWire[]>([]);
  const [latestMemoryAt, setLatestMemoryAt] = useState<number | null>(null);
  const [latestCanvasAt, setLatestCanvasAt] = useState<number | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [msgs, fav, latest, canv] = await Promise.all([
        api<{ messages: WireMessage[] }>('/messages', { query: { limit: 5 } }),
        api<{ memories: FavWire[] }>('/memories', { query: { favorite: 'true', limit: 4 } }),
        api<{ memories: { createdAt: string }[] }>('/memories', { query: { limit: 1 } }),
        api<{ canvases: { updatedAt: string }[] }>('/canvases'),
      ]);
      setRecent(msgs.messages); setFavs(fav.memories);
      setLatestMemoryAt(latest.memories[0] ? Date.parse(latest.memories[0].createdAt) : null);
      setLatestCanvasAt(canv.canvases.length ? Math.max(...canv.canvases.map((c) => Date.parse(c.updatedAt))) : null);
      setNow(Date.now()); setLoadErr(null);
    } catch { setLoadErr('Some of your highlights could not be loaded.'); }
  }, []);
  useEffect(() => {
    if (!visible) return;
    void load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [visible, load]);

  const decrypted: ChatMessage[] = useMemo(() => { void keyTick; return recent.map((w) => e2ee.decrypt(w)).filter((m) => m.state !== 'deleted'); }, [recent, keyTick, e2ee]);
  const favItems = useMemo(() => {
    void keyTick;
    return favs.flatMap((f) => {
      const r = e2ee.decryptMemory(f);
      const p = r.state === 'ok' ? validateMemoryPayload(r.payload, f.type) : null;
      return p ? [{ id: f.id, payload: p as MemoryPayload }] : [];
    });
  }, [favs, keyTick, e2ee]);

  const snippet = (m: ChatMessage) => (m.state === 'locked' ? '🔒 Waiting for the key…' : m.sticker ? m.sticker : m.kind === 'heart' ? '♥' : m.text ? m.text.slice(0, 80) : m.media?.[0] ? (m.media[0].voice ? '🎙️ Voice note' : m.media[0].mime.startsWith('video') ? '🎬 Video' : '📷 Photo') : '…');
  const who = (m: ChatMessage) => (m.senderId === user.id ? 'You' : partnerName);

  const anniversary = couple.anniversaryDate ? anniversaryInfo(couple.anniversaryDate.slice(0, 10), localTodayMs()) : null;
  const activity: Activity[] = [
    ...(decrypted[0] ? [{ icon: '💬', text: `${who(decrypted[0])}: ${snippet(decrypted[0])}`, at: Date.parse(decrypted[0].createdAt) }] : []),
    ...(latestMemoryAt ? [{ icon: '📷', text: 'A memory was added to Our Memories', at: latestMemoryAt }] : []),
    ...(latestCanvasAt ? [{ icon: '🎨', text: 'Your shared canvas was updated', at: latestCanvasAt }] : []),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="mx-auto grid max-w-2xl gap-4 px-3 pb-10">
      <section className="card text-center" aria-label="Our space">
        <div className="flex items-center justify-center">
          <Avatar name={myName} size={72} />
          <Heart className="-mx-2 z-10 h-7 w-7 fill-accent text-accent drop-shadow" aria-hidden />
          <Avatar name={partnerName} size={72} />
        </div>
        <h2 className="mt-3 text-xl font-semibold">{couple.name}</h2>
        <p className="text-sm text-muted">{myName} &amp; {partnerName}</p>
        {anniversary ? (
          <div className="mt-3 rounded-2xl bg-accent2/10 px-4 py-3" aria-live="polite">
            {anniversary.upcoming ? <p><strong>{anniversary.daysToNext}</strong> {anniversary.daysToNext === 1 ? 'day' : 'days'} until your special day 💜</p>
              : anniversary.isToday ? <p className="font-medium">🎉 {anniversary.years > 0 ? `Happy ${anniversary.years}${anniversary.years === 1 ? ' year' : ' years'} together!` : 'Day one. Welcome to your space!'}</p>
              : <><p><strong>{anniversary.daysTogether.toLocaleString()}</strong> days together</p><p className="text-sm text-muted">{anniversary.daysToNext} {anniversary.daysToNext === 1 ? 'day' : 'days'} until your {anniversary.years}{ordinal(anniversary.years)} anniversary</p></>}
          </div>
        ) : <p className="mt-3 text-sm text-muted">Add your anniversary below to start a countdown 💜</p>}
      </section>

      <nav className="grid grid-cols-3 gap-2" aria-label="Quick actions">
        <button className="btn-primary relative flex-col py-3" onClick={() => go('chat')}><MessageCircle className="h-5 w-5" aria-hidden />Chat{unread > 0 && <span className="absolute right-2 top-2 grid h-5 min-w-5 place-items-center rounded-full bg-white px-1 text-xs font-semibold text-accent" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}</button>
        <button className="btn-ghost flex-col py-3" onClick={() => go('canvas')}><Brush className="h-5 w-5" aria-hidden />Draw together</button>
        <button className="btn-ghost flex-col py-3" onClick={() => go('memories')}><Images className="h-5 w-5" aria-hidden />Memories</button>
      </nav>
      {loadErr && <p role="alert" className="text-center text-sm text-red-500">{loadErr}</p>}

      <section className="card" aria-labelledby="h-chat">
        <h3 id="h-chat" className="mb-2 font-medium">Latest conversation</h3>
        {decrypted.length === 0 ? <p className="text-sm text-muted">No messages yet. Say hello 💜</p> : (
          <ul className="grid gap-1.5">{decrypted.slice(0, 3).map((m) => <li key={m.id ?? m.clientMsgId} className="flex justify-between gap-3 text-sm"><span className="truncate"><strong>{who(m)}:</strong> {snippet(m)}</span><span className="shrink-0 text-xs text-muted">{formatRelative(Date.parse(m.createdAt), now)}</span></li>)}</ul>
        )}
      </section>

      <section className="card" aria-labelledby="h-fav">
        <h3 id="h-fav" className="mb-2 font-medium">Favourite memories</h3>
        {favItems.length === 0 ? <p className="text-sm text-muted">Tap ★ on a memory to keep it here.</p> : (
          <ul className="grid grid-cols-2 gap-3">{favItems.map((f) => (
            <li key={f.id} className="min-w-0 text-sm">
              {f.payload.media?.[0] && <MediaView desc={f.payload.media[0]} />}
              <p className="truncate font-medium">{f.payload.title ?? f.payload.caption ?? f.payload.text?.slice(0, 40) ?? ''}</p>
            </li>
          ))}</ul>
        )}
      </section>

      <section className="card" aria-labelledby="h-act">
        <h3 id="h-act" className="mb-2 font-medium">Recent activity</h3>
        {activity.length === 0 ? <p className="text-sm text-muted">Nothing yet. Your first message, drawing or memory will show up here.</p> : (
          <ul className="grid gap-1.5">{activity.map((a) => <li key={a.text} className="flex justify-between gap-3 text-sm"><span className="truncate">{a.icon} {a.text}</span><span className="shrink-0 text-xs text-muted">{formatRelative(a.at, now)}</span></li>)}</ul>
        )}
      </section>

      <RoomSettings couple={couple} onSaved={onCoupleChanged} />
    </div>
  );
}

const ordinal = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th');

function RoomSettings({ couple, onSaved }: { couple: Couple; onSaved: () => void }) {
  const [name, setName] = useState(couple.name);
  const [theme, setTheme] = useState<string>(couple.theme);
  const [date, setDate] = useState(couple.anniversaryDate?.slice(0, 10) ?? '');
  const [ttl, setTtl] = useState(couple.messageTtlSec || 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null); setErr(null);
    const patch: Record<string, unknown> = {};
    if (name.trim() && name.trim() !== couple.name) patch.name = name.trim();
    if (theme !== couple.theme) patch.theme = theme;
    if (date && date !== couple.anniversaryDate?.slice(0, 10)) patch.anniversaryDate = date;
    if (ttl !== (couple.messageTtlSec || 0)) patch.messageTtlSec = ttl;
    if (Object.keys(patch).length === 0) { setMsg('Nothing to change.'); return; }
    setBusy(true);
    try { await api('/couples/me', { method: 'PATCH', body: patch }); setMsg('Saved. Your partner sees the changes too.'); onSaved(); }
    catch (x) { setErr(friendly(x)); } finally { setBusy(false); }
  };
  return (
    <section className="card" aria-labelledby="h-room">
      <h3 id="h-room" className="mb-3 font-medium">Our room</h3>
      <form onSubmit={submit} className="grid gap-3">
        <div><label className="label" htmlFor="rm-name">Room name</label><input id="rm-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></div>
        <fieldset><legend className="label">Theme</legend>
          <div className="flex gap-3">{THEMES.map((t) => (
            <label key={t.id} className="flex cursor-pointer flex-col items-center gap-1 text-xs">
              <input type="radio" name="theme" className="sr-only" checked={theme === t.id} onChange={() => setTheme(t.id)} />
              <span className={`h-10 w-10 rounded-full border-2 ${theme === t.id ? 'border-ink' : 'border-transparent'}`} style={{ background: t.swatch }} aria-hidden />{t.label}
            </label>
          ))}</div>
        </fieldset>
        <div><label className="label" htmlFor="rm-date">Anniversary / first-met date</label><input id="rm-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="label" htmlFor="rm-ttl">Disappearing messages</label>
          <select id="rm-ttl" className="input" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>{TTL_OPTIONS.map((o) => <option key={o.sec} value={o.sec}>{o.label}</option>)}</select></div>
        {err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
        {msg && <p role="status" className="text-sm text-accent2">{msg}</p>}
        <button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
    </section>
  );
}
