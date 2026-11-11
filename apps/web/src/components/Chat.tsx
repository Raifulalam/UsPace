'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Clock, Heart, Lock, Mic, MoreVertical, Paperclip, Pin, Search, Send, Smile, Square, X } from 'lucide-react';
import { matchesQuery, mediaIdsOf, memoryTypeFor, validateMemoryPayload, type Descriptor } from '@couples/media-core';
import { STICKERS, TTL_OPTIONS, groupByDay, lastSeenMessageId } from '@couples/space-core';
import { api, ApiError, tryRefresh } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import type { E2EE } from '@/lib/e2ee';
import type { ChatMessage, Couple, ReadState, User, WireMessage, WireReaction } from '@/lib/types';
import { MediaError, friendly, prepareFile, startRecording, type Recording } from '@/lib/mediaClient';
import MessageBubble, { type ReactionChip } from './MessageBubble';
import { CallCard, RoomSettings } from './Home';

type Kind = 'text' | 'heart' | 'sticker';
type Pending = { clientMsgId: string; kind: Kind; text: string | null; sticker?: string; replyTo?: string; createdAt: string; failed: boolean };
type Props = {
  user: User; couple: Couple; e2ee: E2EE; keyTick: number; keyVersion: number; visible: boolean;
  onKeysUpdated: () => void; onCoupleChanged: () => void; onUnread: (n: number) => void;
};

const byTime = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);
const EDIT_MS = 24 * 3600 * 1000;
const rkey = (r: { messageId: string; userId: string }) => `${r.messageId}:${r.userId}`;
const dayLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

export default function Chat({ user, couple, e2ee, keyTick, keyVersion, visible, onKeysUpdated, onCoupleChanged, onUnread }: Props) {
  const [wire, setWire] = useState<WireMessage[]>([]);
  const [reactions, setReactions] = useState<WireReaction[]>([]);
  const [pinnedWire, setPinnedWire] = useState<WireMessage[]>([]);
  const [readState, setReadState] = useState<ReadState | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [panel, setPanel] = useState<null | 'stickers' | 'timer' | 'pins'>(null);
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [hearts, setHearts] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [uploads, setUploads] = useState<{ key: string; name: string; progress: number; controller: AbortController }[]>([]);
  const [recSeconds, setRecSeconds] = useState<number | null>(null);
  const recRef = useRef<Recording | null>(null);
  const recTimer = useRef<ReturnType<typeof setInterval>>();
  const fileInput = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastTypingEmit = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectSocket>>();
  const onKeysRef = useRef(onKeysUpdated);
  const onUnreadRef = useRef(onUnread);
  const visibleRef = useRef(visible);
  const unreadRef = useRef(0);
  const lastMarked = useRef<string | null>(null);
  onKeysRef.current = onKeysUpdated;
  onUnreadRef.current = onUnread;
  visibleRef.current = visible;
  const partner = couple.members.find((m) => m.id !== user.id);
  const partnerName = partner?.displayName ?? partner?.username ?? 'your partner';
  const tzOffset = -new Date().getTimezoneOffset();

  // ---------- data ----------
  const commit = useCallback((m: WireMessage) => {
    setWire((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m].sort(byTime)));
    setPending((p) => p.filter((x) => x.clientMsgId !== m.clientMsgId));
  }, []);
  const mergeReactions = useCallback((list: WireReaction[]) => setReactions((prev) => {
    const map = new Map(prev.map((r) => [rkey(r), r]));
    for (const r of list) map.set(rkey(r), r);
    return [...map.values()];
  }), []);
  const burst = useCallback(() => {
    const id = Date.now() + Math.random();
    setHearts((h) => [...h, id]);
    setTimeout(() => setHearts((h) => h.filter((x) => x !== id)), 2300);
  }, []);
  const loadPage = useCallback(async (before?: string) => {
    const r = await api<{ messages: WireMessage[]; reactions: WireReaction[]; nextCursor: string | null }>('/messages', { query: { limit: 30, before } });
    setWire((prev) => { const seen = new Set(prev.map((x) => x.id)); return [...r.messages.filter((m) => !seen.has(m.id)), ...prev].sort(byTime); });
    mergeReactions(r.reactions);
    setCursor(r.nextCursor);
    return r.nextCursor;
  }, [mergeReactions]);
  const loadPinned = useCallback(() => api<{ messages: WireMessage[] }>('/messages/pinned').then((r) => setPinnedWire(r.messages)).catch(() => {}), []);
  const loadReadState = useCallback(async () => {
    try {
      const rs = await api<ReadState>('/messages/read-state');
      setReadState(rs);
      if (!visibleRef.current) { unreadRef.current = rs.unread; onUnreadRef.current(rs.unread); }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadPage().catch(() => setErr('Could not load messages')); void loadPinned(); void loadReadState(); }, [loadPage, loadPinned, loadReadState]);
  useEffect(() => { const t = setInterval(() => setNowTick(Date.now()), 30000); return () => clearInterval(t); }, []);

  useEffect(() => {
    const s = connectSocket();
    socketRef.current = s;
    s.on('connect', () => s.emit('couple:join', (r: { ok: boolean }) => setConn(r?.ok ? 'online' : 'offline')));
    s.on('connect_error', async (e: Error) => { setConn('offline'); if (e.message === 'unauthorized') await tryRefresh(); });
    s.on('disconnect', () => setConn('offline'));
    s.on('message:new', (m: WireMessage) => {
      commit(m);
      if (m.kind === 'heart' && m.senderId !== user.id) burst();
      if (m.senderId !== user.id && !visibleRef.current) { unreadRef.current += 1; onUnreadRef.current(unreadRef.current); }
    });
    s.on('message:edited', (m: WireMessage) => { commit(m); setPinnedWire((p) => p.map((x) => (x.id === m.id ? m : x))); });
    s.on('message:deleted', ({ id }: { id: string }) => {
      setWire((p) => p.map((w) => (w.id === id ? { ...w, deleted: true, ciphertext: null, nonce: null, pinned: false } : w)));
      setReactions((r) => r.filter((x) => x.messageId !== id));
      setPinnedWire((p) => p.filter((x) => x.id !== id));
    });
    s.on('message:pinned', ({ id, pinned }: { id: string; pinned: boolean }) => { setWire((p) => p.map((w) => (w.id === id ? { ...w, pinned } : w))); void loadPinned(); });
    s.on('message:reaction', (r: WireReaction & { removed?: boolean }) => {
      if (r.removed) setReactions((list) => list.filter((x) => rkey(x) !== rkey(r)));
      else mergeReactions([r]);
    });
    s.on('message:read', (r: { userId: string; upTo: string }) => { if (r.userId !== user.id) setReadState((rs) => (rs && rs.receiptsEnabled ? { ...rs, partner: r.upTo } : rs)); });
    s.on('typing:update', (t: { userId: string; typing: boolean }) => { if (t.userId !== user.id) setPartnerTyping(t.typing); });
    s.on('presence:update', (p: { userId: string; online: boolean }) => { if (p.userId !== user.id) setPartnerOnline(p.online); });
    s.on('keys:updated', () => onKeysRef.current());
    return () => { s.removeAllListeners(); s.disconnect(); };
  }, [user.id, commit, burst, mergeReactions, loadPinned]);

  // Tell the server how far we have read (this is what powers unread counts and "Seen").
  useEffect(() => {
    if (!visible || wire.length === 0) return;
    unreadRef.current = 0; onUnreadRef.current(0);
    const last = wire[wire.length - 1].id;
    if (last === lastMarked.current) return;
    lastMarked.current = last;
    api('/messages/read', { method: 'PUT', body: { upTo: last } }).catch(() => { lastMarked.current = null; });
    setReadState((rs) => (rs ? { ...rs, mine: last, unread: 0 } : rs));
  }, [visible, wire]);

  const decrypted = useMemo(() => {
    void keyTick; // re-decrypt when new room keys arrive
    return wire.filter((w) => !(w.expiresAt && Date.parse(w.expiresAt) < nowTick)).map((w) => e2ee.decrypt(w));
  }, [wire, keyTick, e2ee, nowTick]);
  const messages: ChatMessage[] = useMemo(() => {
    const local: ChatMessage[] = pending.map((p) => ({ id: null, clientMsgId: p.clientMsgId, senderId: user.id, kind: p.kind, text: p.text, sticker: p.sticker, replyTo: p.replyTo, state: p.failed ? 'failed' : 'sending', createdAt: p.createdAt }));
    return [...decrypted, ...local].sort(byTime);
  }, [decrypted, pending, user.id]);
  const byClient = useMemo(() => new Map(messages.map((m) => [m.clientMsgId, m])), [messages]);
  const chips = useMemo(() => {
    void keyTick;
    const out = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const r of reactions) {
      const emoji = e2ee.decryptReaction(r);
      if (!emoji) continue;
      const per = out.get(r.messageId) ?? new Map<string, { count: number; mine: boolean }>();
      const cur = per.get(emoji) ?? { count: 0, mine: false };
      cur.count += 1; cur.mine = cur.mine || r.userId === user.id;
      per.set(emoji, cur); out.set(r.messageId, per);
    }
    return out;
  }, [reactions, keyTick, e2ee, user.id]);
  const shown = useMemo(() => (query.trim() ? messages.filter((m) => m.state === 'ok' && matchesQuery([m.text, ...(m.media?.map((d) => d.name) ?? [])], query)) : messages), [messages, query]);
  const days = useMemo(() => groupByDay(shown, (m) => m.createdAt, tzOffset), [shown, tzOffset]);
  const pinnedMsgs = useMemo(() => pinnedWire.map((w) => e2ee.decrypt(w)).filter((m) => m.state === 'ok'), [pinnedWire, e2ee, keyTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const seenId = readState?.receiptsEnabled ? lastSeenMessageId(messages, readState.partner, user.id) : null;

  useEffect(() => { if (!query) endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, query]);

  const snippet = (m: ChatMessage) => (m.state === 'deleted' ? 'Deleted message' : m.sticker ? m.sticker : m.kind === 'heart' ? '♥' : m.text ? m.text.slice(0, 90) : m.media?.[0] ? (m.media[0].voice ? 'Voice note' : m.media[0].mime.startsWith('video') ? 'Video' : 'Photo') : '…');

  // ---------- sending ----------
  async function send(kind: Kind, text: string | null, sticker?: string, reply?: ChatMessage | null) {
    setErr(null);
    const payload: Record<string, unknown> = { t: kind, text, sentAt: Date.now() };
    if (sticker) payload.sticker = sticker;
    if (reply) payload.replyTo = reply.clientMsgId;
    let body;
    try { body = e2ee.buildMessage(user.id, kind, keyVersion, payload); }
    catch { setErr('Your device doesn’t have the current key yet.'); return; }
    setPending((p) => [...p, { clientMsgId: body.clientMsgId, kind, text, sticker, replyTo: reply?.clientMsgId, createdAt: new Date().toISOString(), failed: false }]);
    if (kind === 'heart') burst();
    try { commit((await api<{ message: WireMessage }>('/messages', { method: 'POST', body })).message); }
    catch (e) {
      setPending((p) => p.map((x) => (x.clientMsgId === body.clientMsgId ? { ...x, failed: true } : x)));
      if (e instanceof ApiError && e.code === 'KEY_VERSION_STALE') { setErr('Your partner’s keys changed. Updating…'); onKeysRef.current(); } else setErr(friendly(e));
    }
  }
  async function submitEdit(m: ChatMessage, text: string) {
    const payload = { t: m.kind === 'media' ? 'media' : 'text', text: text || null, ...(m.media ? { media: m.media } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), sentAt: Date.now() };
    try {
      const body = e2ee.buildMessage(user.id, m.kind, keyVersion, payload, m.clientMsgId); // same message id: the ciphertext stays bound to this message
      const r = await api<{ message: WireMessage }>(`/messages/${m.id}`, { method: 'PATCH', body: { keyVersion: body.keyVersion, nonce: body.nonce, ciphertext: body.ciphertext } });
      commit(r.message);
    } catch (e) { setErr(friendly(e)); }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (editing) {
      if (!text && editing.kind === 'text') return;
      const m = editing; setEditing(null); setDraft('');
      void submitEdit(m, text);
      return;
    }
    if (!text) return;
    setDraft('');
    const reply = replyTo; setReplyTo(null);
    socketRef.current?.emit('typing:stop');
    void send('text', text, undefined, reply);
  }
  function onType(v: string) {
    setDraft(v);
    const now = Date.now();
    if (now - lastTypingEmit.current > 2000) { socketRef.current?.emit('typing:start'); lastTypingEmit.current = now; }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => socketRef.current?.emit('typing:stop'), 2500);
  }

  // ---------- reactions, pins, deleting ----------
  async function react(m: ChatMessage, emoji: string) {
    if (!m.id) return;
    const mine = reactions.find((r) => r.messageId === m.id && r.userId === user.id);
    try {
      if (mine && e2ee.decryptReaction(mine) === emoji) {
        setReactions((l) => l.filter((x) => rkey(x) !== rkey(mine)));
        await api(`/messages/${m.id}/reaction`, { method: 'DELETE' });
      } else {
        const r = await api<{ reaction: WireReaction }>(`/messages/${m.id}/reaction`, { method: 'PUT', body: e2ee.buildReaction(m.id, user.id, keyVersion, emoji) });
        mergeReactions([r.reaction]);
      }
    } catch (e) { setErr(friendly(e)); }
  }
  async function togglePin(m: ChatMessage) {
    if (!m.id) return;
    try { await api(`/messages/${m.id}/pin`, { method: m.pinned ? 'DELETE' : 'PUT' }); } catch (e) { setErr(friendly(e)); }
  }
  async function remove(m: ChatMessage) {
    if (!m.id || !confirm('Delete this message for both of you?')) return;
    setWire((p) => p.map((w) => (w.id === m.id ? { ...w, deleted: true, ciphertext: null, nonce: null } : w)));
    await api(`/messages/${m.id}`, { method: 'DELETE' }).catch(() => setErr('Could not delete message.'));
  }
  async function setTtl(sec: number) {
    try { await api('/couples/me', { method: 'PATCH', body: { messageTtlSec: sec } }); onCoupleChanged(); setPanel(null); } catch (e) { setErr(friendly(e)); }
  }
  async function searchOlder() { let c: string | null = cursor; for (let i = 0; c && i < 30; i++) c = await loadPage(c); }
  const jumpTo = (id: string | null) => { if (id) document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setPanel(null); };

  // ---------- attachments, voice notes, saving ----------
  async function sendMedia(desc: Descriptor, caption: string | null) {
    const body = e2ee.buildMessage(user.id, 'media', keyVersion, { t: 'media', text: caption, media: [desc], sentAt: Date.now() });
    commit((await api<{ message: WireMessage }>('/messages', { method: 'POST', body: { ...body, mediaIds: mediaIdsOf([desc]) } })).message);
  }
  async function uploadAndSend(file: Blob, name: string, opts: { durOverride?: number; voice?: boolean } = {}) {
    const key = `${Date.now()}-${Math.random()}`;
    const controller = new AbortController();
    setUploads((u) => [...u, { key, name, progress: 0, controller }]);
    try {
      const desc = await prepareFile(file, { name, signal: controller.signal, onProgress: (f) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: f } : x))), ...opts });
      await sendMedia(desc, null);
    } catch (e) {
      if (!(e instanceof MediaError && e.code === 'CANCELLED')) setErr(friendly(e)); // cancelling is not an error
    } finally { setUploads((u) => u.filter((x) => x.key !== key)); }
  }
  async function attach(files: FileList | null) {
    setErr(null);
    for (const f of Array.from(files ?? []).slice(0, 4)) await uploadAndSend(f, f.name);
    if (fileInput.current) fileInput.current.value = '';
  }
  async function toggleRecord() {
    setErr(null);
    if (recRef.current) {
      clearInterval(recTimer.current);
      const rec = recRef.current; recRef.current = null; setRecSeconds(null);
      const { blob, seconds } = await rec.stop();
      if (seconds < 0.5) return;
      await uploadAndSend(blob, 'Voice note', { durOverride: seconds, voice: true });
      return;
    }
    try {
      recRef.current = await startRecording(300, () => { void toggleRecord(); });
      const t0 = Date.now(); setRecSeconds(0);
      recTimer.current = setInterval(() => setRecSeconds(Math.floor((Date.now() - t0) / 1000)), 500);
    } catch (e) { setErr(friendly(e)); }
  }
  useEffect(() => () => { clearInterval(recTimer.current); recRef.current?.cancel(); }, []);

  async function saveToMemories(m: ChatMessage) {
    setErr(null); setNote(null);
    const first = m.media?.[0];
    const type = first ? memoryTypeFor(first) : 'message';
    const text = m.text ?? (m.sticker ? m.sticker : undefined);
    const payload = type && validateMemoryPayload({ v: 1, text, media: m.media, from: m.senderId === user.id ? user.displayName : partnerName, sentAt: Date.parse(m.createdAt) }, type);
    if (!type || !payload) { setErr('This message can’t be saved to Our Memories.'); return; }
    try {
      const body = e2ee.buildMemory(user.id, type, keyVersion, payload);
      await api('/memories', { method: 'POST', body: { ...body, eventDate: m.createdAt.slice(0, 10), mediaIds: mediaIdsOf(payload.media) } });
      setNote('Saved to Our Memories ♥'); setTimeout(() => setNote(null), 3000);
    } catch (e) { setErr(friendly(e)); }
  }

  const ttlLabel = TTL_OPTIONS.find((o) => o.sec === (couple.messageTtlSec || 0))?.label ?? 'Off';
  const canEdit = (m: ChatMessage) => m.senderId === user.id && (m.kind === 'text' || m.kind === 'media') && !m.sticker && Date.now() - Date.parse(m.createdAt) < EDIT_MS;

  return (
    <section className="relative flex h-[calc(100vh-8.5rem)] w-full flex-col px-3 pb-3 sm:px-6 lg:px-10" aria-label={`Chat with ${partnerName}`}>
      <div className="flex items-center justify-between gap-2 py-2 text-xs text-muted">
        <p aria-live="polite"><Lock className="mr-1 inline h-3 w-3" aria-hidden />End-to-end encrypted · {partnerName} {partnerOnline ? 'is online' : ''} {conn !== 'online' ? `· ${conn}` : ''}</p>
        <div className="flex items-center gap-1">
          {pinnedMsgs.length > 0 && <button className="btn-ghost px-2 py-1" aria-label={`${pinnedMsgs.length} pinned messages`} onClick={() => setPanel(panel === 'pins' ? null : 'pins')}><Pin className="h-3.5 w-3.5" aria-hidden />{pinnedMsgs.length}</button>}
          <button className={`btn-ghost px-2 py-1 ${couple.messageTtlSec ? 'border-accent2' : ''}`} aria-label={`Disappearing messages: ${ttlLabel}`} onClick={() => setPanel(panel === 'timer' ? null : 'timer')}><Clock className="h-3.5 w-3.5" aria-hidden />{couple.messageTtlSec ? ttlLabel : ''}</button>
          <button className="btn-ghost px-2 py-1" aria-label="Search messages" aria-pressed={showSearch} onClick={() => { setShowSearch((v) => !v); setQuery(''); }}><Search className="h-3.5 w-3.5" /></button>
          <button className="btn-ghost px-2 py-1" aria-label="More chat options" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}><MoreVertical className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <CallCard partnerName={partnerName} visible={visible} />
      {showMore && (
        <div className="grid gap-3" role="menu" aria-label="Chat options">
          <section className="card" aria-labelledby="h-act">
            <h3 id="h-act" className="mb-2 font-medium">Recent activity</h3>
            {messages.length === 0 ? <p className="text-sm text-muted">No conversation activity yet.</p> : (
              <ul className="grid gap-1.5">{messages.slice(-5).reverse().map((m) => <li key={m.id ?? m.clientMsgId} className="flex justify-between gap-3 text-sm"><span className="truncate">{m.senderId === user.id ? 'You' : partnerName}: {snippet(m)}</span><span className="shrink-0 text-xs text-muted">{formatRelative(Date.parse(m.createdAt), nowTick)}</span></li>)}</ul>
            )}
          </section>
          <RoomSettings couple={couple} onSaved={onCoupleChanged} />
        </div>
      )}

      {showSearch && (
        <div className="mb-2 flex items-center gap-2">
          <label className="sr-only" htmlFor="chat-search">Search messages</label>
          <input id="chat-search" className="input py-2" placeholder="Search this conversation…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          {cursor && <button className="btn-ghost shrink-0 text-xs" onClick={searchOlder}>Include older</button>}
        </div>
      )}
      {panel === 'timer' && (
        <div className="card mb-2 grid gap-2 p-3" role="group" aria-label="Disappearing messages">
          <p className="text-sm">New messages disappear for both of you after:</p>
          <div className="flex flex-wrap gap-2">{TTL_OPTIONS.map((o) => <button key={o.sec} className={`btn-ghost px-3 py-1.5 text-sm ${(couple.messageTtlSec || 0) === o.sec ? 'border-accent2 bg-accent2/20' : ''}`} aria-pressed={(couple.messageTtlSec || 0) === o.sec} onClick={() => setTtl(o.sec)}>{o.label}</button>)}</div>
          <p className="text-xs text-muted">Applies to messages sent from now on. Either of you can change it. A partner could still screenshot or copy a message before it disappears.</p>
        </div>
      )}
      {panel === 'pins' && (
        <ul className="card mb-2 grid max-h-40 gap-1 overflow-y-auto p-3 text-sm" aria-label="Pinned messages">
          {pinnedMsgs.map((m) => <li key={m.id}><button className="w-full truncate text-left hover:underline" onClick={() => jumpTo(m.id)}>📌 {snippet(m)}</button></li>)}
        </ul>
      )}
      {couple.messageTtlSec > 0 && panel !== 'timer' && <p className="mb-1 text-center text-xs text-muted">⏳ New messages disappear after {ttlLabel}.</p>}

      <div className="flex-1 overflow-y-auto rounded-3xl border border-line bg-surface/50 p-3" role="log" aria-live="polite" aria-relevant="additions">
        {cursor && !query && <button className="btn-ghost mx-auto mb-3 block text-sm" onClick={() => loadPage(cursor).catch(() => setErr('Could not load earlier messages'))}>Load earlier messages</button>}
        {shown.length === 0 && <p className="mt-10 text-center text-muted">{query ? 'No messages match.' : 'Say hello 💜 Everything here is encrypted before it leaves your device.'}</p>}
        <ul className="grid gap-2">
          {days.map((g) => (
            <li key={g.key} className="grid gap-2" aria-label={dayLabel(g.key)}>
              <p className="my-1 text-center text-xs text-muted" role="separator">{dayLabel(g.key)}</p>
              <ul className="grid gap-2">
                {g.items.map((m) => {
                  const q = m.replyTo ? byClient.get(m.replyTo) : undefined;
                  const per = m.id ? chips.get(m.id) : undefined;
                  const list: ReactionChip[] = per ? [...per].map(([emoji, v]) => ({ emoji, ...v })) : [];
                  return (
                    <MessageBubble key={m.id ?? m.clientMsgId} m={m} mine={m.senderId === user.id}
                      quoted={q ? { name: q.senderId === user.id ? 'You' : partnerName, text: snippet(q) } : null} replyMissing={Boolean(m.replyTo && !q)}
                      reactions={list} seen={m.id !== null && m.id === seenId} canEdit={canEdit(m)}
                      onReact={(e) => react(m, e)} onReply={() => { setEditing(null); setReplyTo(m); }}
                      onEdit={() => { setReplyTo(null); setEditing(m); setDraft(m.text ?? ''); }} onPin={() => togglePin(m)} onSave={() => saveToMemories(m)} onDelete={() => remove(m)}
                      onRetry={() => { setPending((p) => p.filter((x) => x.clientMsgId !== m.clientMsgId)); void send(m.kind === 'heart' ? 'heart' : m.sticker ? 'sticker' : 'text', m.text, m.sticker, m.replyTo ? byClient.get(m.replyTo) : null); }} />
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div ref={endRef} />
      </div>

      {uploads.map((u) => (
        <p key={u.key} className="flex items-center gap-2 px-2 pt-1 text-xs text-muted" role="status">
          Sending {u.name}… {Math.round(u.progress * 100)}%
          <button className="underline" aria-label={`Cancel sending ${u.name}`} onClick={() => u.controller.abort()}><X className="inline h-3 w-3" /></button>
        </p>
      ))}
      <p className="h-5 px-2 text-xs text-muted" aria-live="polite">{partnerTyping ? `${partnerName} is typing…` : ''}{note && <span className="text-accent2">{note} </span>}{err && <span role="alert" className="text-red-500">{err}</span>}</p>

      {panel === 'stickers' && (
        <div className="card mb-2 grid grid-cols-6 gap-1 p-2" role="group" aria-label="Stickers">
          {STICKERS.map((s) => <button key={s} className="rounded-xl p-1 text-3xl hover:bg-line/50" aria-label={`Send sticker ${s}`} onClick={() => { setPanel(null); void send('sticker', null, s, replyTo); setReplyTo(null); }}>{s}</button>)}
        </div>
      )}
      {(replyTo || editing) && (
        <div className="mb-1 flex items-center justify-between gap-2 rounded-2xl border border-line bg-surface px-3 py-1.5 text-xs">
          <span className="truncate">{editing ? 'Editing your message' : <>Replying to <strong>{replyTo!.senderId === user.id ? 'yourself' : partnerName}</strong>: {snippet(replyTo!)}</>}</span>
          <button aria-label="Cancel" onClick={() => { setReplyTo(null); setEditing(null); setDraft(''); }}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      <form onSubmit={submit} className="flex items-center gap-2">
        <button type="button" className="btn-ghost px-2.5" aria-label="Send a heart" onClick={() => send('heart', null)}><Heart className="h-5 w-5 text-accent" /></button>
        <button type="button" className="btn-ghost px-2.5" aria-label="Stickers" aria-pressed={panel === 'stickers'} onClick={() => setPanel(panel === 'stickers' ? null : 'stickers')}><Smile className="h-5 w-5" /></button>
        <input ref={fileInput} type="file" multiple hidden accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" onChange={(e) => attach(e.target.files)} aria-hidden tabIndex={-1} />
        <button type="button" className="btn-ghost px-2.5" aria-label="Attach photo or video" onClick={() => fileInput.current?.click()}><Paperclip className="h-5 w-5" /></button>
        <button type="button" className={`btn-ghost px-2.5 ${recSeconds !== null ? 'border-red-500 text-red-500' : ''}`} aria-label={recSeconds !== null ? 'Stop and send voice note' : 'Record a voice note'} aria-pressed={recSeconds !== null} onClick={toggleRecord}>
          {recSeconds !== null ? <><Square className="h-4 w-4 fill-current" /><span className="text-xs tabular-nums">{recSeconds}s</span></> : <Mic className="h-5 w-5" />}
        </button>
        <label className="sr-only" htmlFor="draft">Message</label>
        <input id="draft" className="input" placeholder={editing ? 'Edit your message…' : 'Write something sweet…'} value={draft} maxLength={2000} onChange={(e) => onType(e.target.value)} autoComplete="off" />
        <button className="btn-primary" aria-label={editing ? 'Save edit' : 'Send message'} disabled={!draft.trim() && !(editing && editing.kind === 'media')}><Send className="h-5 w-5" /></button>
      </form>
      <div className="pointer-events-none absolute bottom-20 right-8" aria-hidden>
        {hearts.map((id) => <Heart key={id} className="heart-float absolute h-8 w-8 fill-accent text-accent" style={{ right: id % 60 }} />)}
      </div>
    </section>
  );
}
