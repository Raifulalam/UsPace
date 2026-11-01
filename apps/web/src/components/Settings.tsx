'use client';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Download, X } from 'lucide-react';
import { api, ApiError, setToken } from '@/lib/api';
import { saveBlob } from '@/lib/mediaClient';
import { useAuth } from '@/lib/session';

type Session = { id: string; device: string; network: string | null; lastActive: string; current: boolean };
const say = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) && e.details.length ? (e.details as { message: string }[]).map((d) => d.message).join(' · ') : e.message) : e instanceof Error ? e.message : 'Something went wrong.');

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return <section className="card mb-4 grid gap-3" aria-labelledby={id}><h3 id={id} className="font-medium">{title}</h3>{children}</section>;
}
function Msg({ err, ok }: { err: string | null; ok: string | null }) {
  return <>{err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}{ok && <p role="status" className="rounded-xl bg-accent2/10 px-3 py-2 text-sm">{ok}</p>}</>;
}
/** Runs an action, showing busy/error/success in one place. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setErr(null); setOk(null); setBusy(true);
    try { const m = await fn(); if (m) setOk(m); } catch (e) { setErr(say(e)); } finally { setBusy(false); }
  };
  return { busy, err, ok, run };
}

export default function Settings({ onClose, hasPartner }: { onClose: () => void; hasPartner: boolean }) {
  const { logout } = useAuth();
  return (
    <aside role="dialog" aria-modal="true" aria-labelledby="set-h" className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line bg-bg p-5 shadow-soft">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="set-h" className="text-lg font-semibold">Settings</h2>
        <button className="btn-ghost" aria-label="Close settings" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      <PasswordSection />
      <SessionsSection onSignedOut={logout} />
      <BlocksSection />
      <ReportSection hasPartner={hasPartner} />
      <DataSection onDeleted={logout} />
    </aside>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const a = useAction();
  const submit = (e: FormEvent) => { e.preventDefault(); void a.run(async () => {
    const r = await api<{ accessToken: string }>('/users/me/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
    setToken(r.accessToken); setCurrent(''); setNext('');
    return 'Password changed. Your other devices were signed out.';
  }); };
  return (
    <Section id="s-pw" title="Password">
      <form onSubmit={submit} className="grid gap-2">
        <label className="label" htmlFor="pw-cur">Current password</label>
        <input id="pw-cur" type="password" required className="input" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label className="label" htmlFor="pw-new">New password (10+ characters)</label>
        <input id="pw-new" type="password" required minLength={10} className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <Msg err={a.err} ok={a.ok} />
        <button className="btn-primary" disabled={a.busy}>Change password</button>
      </form>
    </Section>
  );
}

function SessionsSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const a = useAction();
  const load = useCallback(async () => { try { setSessions((await api<{ sessions: Session[] }>('/users/me/sessions')).sessions); } catch { setSessions([]); } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section id="s-sess" title="Where you’re signed in">
      <ul className="grid gap-2">
        {(sessions ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 rounded-2xl border border-line p-3 text-sm">
            <span><strong>{s.device}</strong>{s.current && <span className="ml-2 rounded-full bg-accent2/20 px-2 text-xs">this device</span>}<br /><span className="text-xs text-muted">{s.network ?? 'Unknown network'} · {new Date(s.lastActive).toLocaleString()}</span></span>
            {!s.current && <button className="btn-ghost shrink-0" disabled={a.busy} onClick={() => a.run(async () => { await api(`/users/me/sessions/${s.id}`, { method: 'DELETE' }); await load(); })}>Sign out</button>}
          </li>
        ))}
      </ul>
      <Msg err={a.err} ok={a.ok} />
      <button className="btn-ghost" disabled={a.busy} onClick={() => { if (confirm('Sign out of every device, including this one?')) void a.run(async () => { await api('/users/me/sessions/revoke-all', { method: 'POST' }); onSignedOut(); }); }}>Sign out everywhere</button>
    </Section>
  );
}

function BlocksSection() {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState('');
  const a = useAction();
  const load = useCallback(async () => { try { setNames((await api<{ usernames: string[] }>('/safety/blocks')).usernames); } catch { /* ignore */ } }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <Section id="s-block" title="Blocked people">
      <p className="text-sm text-muted">Blocked people can’t use your invitation codes, and you can’t use theirs. They are not told.</p>
      <ul className="grid gap-1">{names.map((n) => <li key={n} className="flex items-center justify-between text-sm">@{n}<button className="btn-ghost px-2 py-1" onClick={() => a.run(async () => { await api(`/safety/blocks/${encodeURIComponent(n)}`, { method: 'DELETE' }); await load(); })}>Unblock</button></li>)}</ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/safety/blocks', { method: 'POST', body: { username: name.trim().replace(/^@/, '') } }); setName(''); await load(); }); }}>
        <label className="sr-only" htmlFor="blk">Username to block</label>
        <input id="blk" className="input" placeholder="username" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-ghost" disabled={a.busy}>Block</button>
      </form>
      <Msg err={a.err} ok={a.ok} />
    </Section>
  );
}

function ReportSection({ hasPartner }: { hasPartner: boolean }) {
  const [category, setCategory] = useState('harassment');
  const [target, setTarget] = useState<'partner' | 'user'>(hasPartner ? 'partner' : 'user');
  const [username, setUsername] = useState('');
  const [details, setDetails] = useState('');
  const [evidence, setEvidence] = useState('');
  const a = useAction();
  const submit = (e: FormEvent) => { e.preventDefault(); void a.run(async () => {
    await api('/safety/reports', { method: 'POST', body: { category, target, ...(target === 'user' ? { username: username.trim().replace(/^@/, '') } : {}), ...(details.trim() ? { details: details.trim() } : {}), ...(evidence.trim() ? { evidence: evidence.trim() } : {}) } });
    setDetails(''); setEvidence('');
    return 'Thank you. Our safety team will review your report.';
  }); };
  return (
    <Section id="s-rep" title="Report a problem">
      <p className="text-sm text-muted">Your messages are end-to-end encrypted, so we can’t see them. If you want us to look at something, paste only the part you’re comfortable sharing. We can’t verify it.</p>
      <form onSubmit={submit} className="grid gap-2">
        <label className="label" htmlFor="rp-cat">What happened?</label>
        <select id="rp-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="harassment">Harassment or threats</option><option value="impersonation">Pretending to be someone else</option>
          <option value="underage">Someone who seems under 18</option><option value="sexual_content">Unwanted sexual content</option>
          <option value="spam">Spam or scams</option><option value="other">Something else</option>
        </select>
        <fieldset className="flex gap-4 text-sm"><legend className="sr-only">Who</legend>
          {hasPartner && <label className="flex items-center gap-1"><input type="radio" checked={target === 'partner'} onChange={() => setTarget('partner')} />My partner</label>}
          <label className="flex items-center gap-1"><input type="radio" checked={target === 'user'} onChange={() => setTarget('user')} />Another person</label>
        </fieldset>
        {target === 'user' && <><label className="label" htmlFor="rp-user">Their username</label><input id="rp-user" className="input" required value={username} onChange={(e) => setUsername(e.target.value)} /></>}
        <label className="label" htmlFor="rp-det">Details (optional)</label>
        <textarea id="rp-det" className="input" rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)} />
        <label className="label" htmlFor="rp-ev">Text you want us to see (optional)</label>
        <textarea id="rp-ev" className="input" rows={3} maxLength={3000} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        <Msg err={a.err} ok={a.ok} />
        <button className="btn-ghost" disabled={a.busy}>Send report</button>
      </form>
    </Section>
  );
}

function DataSection({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);
  const exp = useAction();
  const del = useAction();
  return (
    <Section id="s-data" title="Your data">
      <button className="btn-ghost" disabled={exp.busy} onClick={() => exp.run(async () => {
        const data = await api<unknown>('/users/me/export');
        saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'our-space-account-data.json');
        return 'Downloaded. Messages, memories and drawings are encrypted and stay in the app.';
      })}><Download className="h-4 w-4" aria-hidden />Download my account data</button>
      <Msg err={exp.err} ok={exp.ok} />
      <hr className="border-line" />
      <h4 className="font-medium text-red-500">Delete my account</h4>
      <p className="text-sm text-muted">Your room closes right away for both of you. After 14 days your account is permanently deleted (you can restore it before then). The room’s messages, drawings, memories and files are permanently deleted 30 days after it closes.</p>
      <label className="label" htmlFor="del-pw">Confirm with your password</label>
      <input id="del-pw" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />I understand this ends our room.</label>
      <Msg err={del.err} ok={del.ok} />
      <button className="btn-ghost border-red-500 text-red-500" disabled={del.busy || !sure || !password} onClick={() => del.run(async () => {
        await api('/users/me/deletion', { method: 'POST', body: { password } });
        setToken(null); onDeleted();
      })}>Delete my account</button>
    </Section>
  );
}
