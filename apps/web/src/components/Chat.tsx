'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Heart, Lock, Send, Trash2, TriangleAlert } from 'lucide-react';
import { api, ApiError, tryRefresh } from '@/lib/api';
import { connectSocket } from '@/lib/socket';
import type { E2EE } from '@/lib/e2ee';
import type { ChatMessage, Couple, User, WireMessage } from '@/lib/types';

type Pending = { clientMsgId: string; kind: 'text' | 'heart'; text: string | null; createdAt: string; failed: boolean };
type Props = { user: User; couple: Couple; e2ee: E2EE; keyTick: number; keyVersion: number; onKeysUpdated: () => void };

const byTime = (a: { createdAt: string }, b: { createdAt: string }) => a.createdAt.localeCompare(b.createdAt);

export default function Chat({ user, couple, e2ee, keyTick, keyVersion, onKeysUpdated }: Props) {
  const [wire, setWire] = useState<WireMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [conn, setConn] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [partnerOnline, setPartnerOnline] = useState(false);
  const [hearts, setHearts] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastTypingEmit = useRef(0);
  const socketRef = useRef<ReturnType<typeof connectSocket>>();
  const onKeysRef = useRef(onKeysUpdated);
  onKeysRef.current = onKeysUpdated;
  const partner = couple.members.find((m) => m.id !== user.id);
  const partnerName = partner?.displayName ?? partner?.username ?? 'your partner';

  const commit = useCallback((m: WireMessage) => {
    setWire((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m].sort(byTime)));
    setPending((p) => p.filter((x) => x.clientMsgId !== m.clientMsgId));
  }, []);
  const burst = useCallback(() => {
    const id = Date.now() + Math.random();
    setHearts((h) => [...h, id]);
    setTimeout(() => setHearts((h) => h.filter((x) => x !== id)), 2300);
  }, []);

  const loadPage = useCallback(async (before?: string) => {
    const r = await api<{ messages: WireMessage[]; nextCursor: string | null }>('/messages', { query: { limit: 30, before } });
    setWire((prev) => {
      const seen = new Set(prev.map((x) => x.id));
      return [...r.messages.filter((m) => !seen.has(m.id)), ...prev].sort(byTime);
    });
    setCursor(r.nextCursor);
  }, []);

  useEffect(() => { loadPage().catch(() => setErr('Could not load messages')); }, [loadPage]);

  useEffect(() => {
    const s = connectSocket();
    socketRef.current = s;
    s.on('connect', () => s.emit('couple:join', (r: { ok: boolean }) => setConn(r?.ok ? 'online' : 'offline')));
    s.on('connect_error', async (e: Error) => { setConn('offline'); if (e.message === 'unauthorized') await tryRefresh(); });
    s.on('disconnect', () => setConn('offline'));
    s.on('message:new', (m: WireMessage) => { commit(m); if (m.kind === 'heart' && m.senderId !== user.id) burst(); });
    s.on('message:deleted', ({ id }: { id: string }) => setWire((p) => p.map((w) => (w.id === id ? { ...w, deleted: true, ciphertext: null, nonce: null } : w))));
    s.on('typing:update', (t: { userId: string; typing: boolean }) => { if (t.userId !== user.id) setPartnerTyping(t.typing); });
    s.on('presence:update', (p: { userId: string; online: boolean }) => { if (p.userId !== user.id) setPartnerOnline(p.online); });
    s.on('keys:updated', () => onKeysRef.current());
    return () => { s.removeAllListeners(); s.disconnect(); };
  }, [user.id, commit, burst]);

  const messages: ChatMessage[] = useMemo(() => {
    // keyTick forces re-decryption when new room keys arrive.
    void keyTick;
    const real = wire.map((w) => e2ee.decrypt(w));
    const local: ChatMessage[] = pending.map((p) => ({ id: null, clientMsgId: p.clientMsgId, senderId: user.id, kind: p.kind, text: p.text, state: p.failed ? 'failed' : 'sending', createdAt: p.createdAt }));
    return [...real, ...local].sort(byTime);
  }, [wire, pending, keyTick, e2ee, user.id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length]);

  async function send(kind: 'text' | 'heart', text: string | null) {
    setErr(null);
    let body;
    try { body = e2ee.buildMessage(user.id, kind, keyVersion, { t: kind, text, sentAt: Date.now() }); }
    catch { setErr('Your device doesn’t have the current key yet.'); return; }
    setPending((p) => [...p, { clientMsgId: body.clientMsgId, kind, text, createdAt: new Date().toISOString(), failed: false }]);
    if (kind === 'heart') burst();
    try {
      const r = await api<{ message: WireMessage }>('/messages', { method: 'POST', body });
      commit(r.message);
    } catch (e) {
      setPending((p) => p.map((x) => (x.clientMsgId === body.clientMsgId ? { ...x, failed: true } : x)));
      if (e instanceof ApiError && e.code === 'KEY_VERSION_STALE') { setErr('Your partner’s keys changed. Updating…'); onKeysRef.current(); }
      else setErr('Message not sent.');
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    socketRef.current?.emit('typing:stop');
    send('text', text);
  }
  function onType(v: string) {
    setDraft(v);
    const now = Date.now();
    if (now - lastTypingEmit.current > 2000) { socketRef.current?.emit('typing:start'); lastTypingEmit.current = now; }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => socketRef.current?.emit('typing:stop'), 2500);
  }
  async function remove(m: ChatMessage) {
    if (!m.id || !confirm('Delete this message for both of you?')) return;
    setWire((p) => p.map((w) => (w.id === m.id ? { ...w, deleted: true, ciphertext: null, nonce: null } : w)));
    await api(`/messages/${m.id}`, { method: 'DELETE' }).catch(() => setErr('Could not delete message.'));
  }
  const retry = (m: ChatMessage) => { setPending((p) => p.filter((x) => x.clientMsgId !== m.clientMsgId)); send(m.kind === 'heart' ? 'heart' : 'text', m.text); };

  return (
    <section className="relative mx-auto flex h-[calc(100vh-8.5rem)] max-w-2xl flex-col px-3 pb-3" aria-label={`Chat with ${partnerName}`}>
      <p className="py-2 text-center text-xs text-muted" aria-live="polite">
        <Lock className="mr-1 inline h-3 w-3" aria-hidden />End-to-end encrypted · {partnerName} {partnerOnline ? 'is online' : ''} {conn !== 'online' ? `· ${conn}` : ''}
      </p>
      <div className="flex-1 overflow-y-auto rounded-3xl border border-line bg-surface/50 p-3" role="log" aria-live="polite" aria-relevant="additions">
        {cursor && <button className="btn-ghost mx-auto mb-3 block text-sm" onClick={() => loadPage(cursor).catch(() => setErr('Could not load earlier messages'))}>Load earlier messages</button>}
        {messages.length === 0 && <p className="mt-10 text-center text-muted">Say hello 💜 Everything here is encrypted before it leaves your device.</p>}
        <ul className="grid gap-2">
          {messages.map((m) => {
            const mine = m.senderId === user.id;
            return (
              <li key={m.id ?? m.clientMsgId} className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-3xl px-4 py-2 ${mine ? 'bg-gradient-to-r from-accent to-accent2 text-white' : 'border border-line bg-surface'} ${m.state === 'sending' ? 'opacity-60' : ''}`}>
                  {m.state === 'locked' && <span className="flex items-center gap-1 italic opacity-80"><Lock className="h-3 w-3" aria-hidden />Waiting for the key…</span>}
                  {m.state === 'tampered' && <span className="flex items-center gap-1 italic"><TriangleAlert className="h-3 w-3" aria-hidden />Couldn’t verify this message</span>}
                  {m.state === 'deleted' && <span className="italic opacity-70">Message deleted</span>}
                  {(m.state === 'ok' || m.state === 'sending' || m.state === 'failed') && (m.kind === 'heart' ? <Heart className="h-7 w-7 fill-current" aria-label="Heart" /> : <p className="whitespace-pre-wrap break-words">{m.text}</p>)}
                  <p className="mt-0.5 flex items-center justify-end gap-2 text-[10px] opacity-70">
                    {m.state === 'failed' && <button className="underline" onClick={() => retry(m)}>Not sent — retry</button>}
                    {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {mine && m.id && m.state === 'ok' && <button aria-label="Delete message" className="opacity-0 transition group-hover:opacity-100 focus:opacity-100" onClick={() => remove(m)}><Trash2 className="h-3 w-3" /></button>}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
        <div ref={endRef} />
      </div>
      <p className="h-5 px-2 text-xs text-muted" aria-live="polite">{partnerTyping ? `${partnerName} is typing…` : ''}{err && <span role="alert" className="text-red-500">{err}</span>}</p>
      <form onSubmit={submit} className="flex items-center gap-2">
        <button type="button" className="btn-ghost" aria-label="Send a heart" onClick={() => send('heart', null)}><Heart className="h-5 w-5 text-accent" /></button>
        <label className="sr-only" htmlFor="draft">Message</label>
        <input id="draft" className="input" placeholder="Write something sweet…" value={draft} maxLength={2000} onChange={(e) => onType(e.target.value)} autoComplete="off" />
        <button className="btn-primary" aria-label="Send message" disabled={!draft.trim()}><Send className="h-5 w-5" /></button>
      </form>
      <div className="pointer-events-none absolute bottom-20 right-8" aria-hidden>
        {hearts.map((id) => <Heart key={id} className="heart-float absolute h-8 w-8 fill-accent text-accent" style={{ right: (id % 60) }} />)}
      </div>
    </section>
  );
}
