'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, authCall, say, setToken, signOut, tryRefresh, type Admin, type Session } from '@/lib/api';
import { can } from '@/lib/perms';
import { ErrorNote } from './ui';
import { Overview, Safety } from './panels/Overview';
import { Rooms, Users } from './panels/UsersRooms';
import { Audit, Reports } from './panels/ReportsAudit';
import { AdminsPanel, SettingsPanel } from './panels/SettingsAdmins';

type Stage =
  | { kind: 'loading' } | { kind: 'login'; notice?: string } | { kind: 'setup'; token: string }
  | { kind: 'mfa'; pre: string } | { kind: 'enroll'; pre: string; secret: string; uri: string }
  | { kind: 'recovery'; codes: string[]; session: Session } | { kind: 'app'; admin: Admin };
type Step = { stage: 'mfa' | 'enroll'; preAuthToken: string; secret?: string; otpauthUri?: string };

const Card = ({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) => (
  <main className="mx-auto grid min-h-screen max-w-md content-center gap-4 px-5 py-10">
    <div><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Our Space</p><h1 className="text-2xl font-semibold">{title}</h1>{intro && <p className="mt-1 text-sm text-slate-600">{intro}</p>}</div>
    <div className="panel grid gap-3">{children}</div>
  </main>
);

export default function AdminApp() {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const toStep = (s: Step): Stage => (s.stage === 'mfa' ? { kind: 'mfa', pre: s.preAuthToken } : { kind: 'enroll', pre: s.preAuthToken, secret: s.secret ?? '', uri: s.otpauthUri ?? '' });

  useEffect(() => {
    const setup = new URLSearchParams(window.location.search).get('setup');
    if (setup) { setStage({ kind: 'setup', token: setup }); return; }
    tryRefresh().then((s) => setStage(s ? { kind: 'app', admin: s.admin } : { kind: 'login' }));
  }, []);

  const logout = (notice?: string) => { setToken(null); setStage({ kind: 'login', notice }); };

  switch (stage.kind) {
    case 'loading': return <main className="grid min-h-screen place-items-center text-slate-500">Loading…</main>;
    case 'login': return <Login notice={stage.notice} onStep={(s) => setStage(toStep(s))} />;
    case 'setup': return <Setup token={stage.token} onStep={(s) => { window.history.replaceState(null, '', '/'); setStage(toStep(s)); }} />;
    case 'mfa': return <Mfa pre={stage.pre} onSession={(s) => { setToken(s.accessToken); setStage({ kind: 'app', admin: s.admin }); }} onRestart={(n) => setStage({ kind: 'login', notice: n })} />;
    case 'enroll': return <Enroll {...stage} onSession={(s) => (s.recoveryCodes ? setStage({ kind: 'recovery', codes: s.recoveryCodes, session: s }) : setStage({ kind: 'app', admin: s.admin }))} onRestart={(n) => setStage({ kind: 'login', notice: n })} />;
    case 'recovery': return <Recovery codes={stage.codes} onDone={() => { setToken(stage.session.accessToken); setStage({ kind: 'app', admin: stage.session.admin }); }} />;
    case 'app': return <Shell admin={stage.admin} onLogout={logout} />;
  }
}

function useForm(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => { e.preventDefault(); setErr(null); setBusy(true); try { await run(); } catch (x) { setErr(say(x)); } finally { setBusy(false); } };
  return { busy, err, submit, setErr };
}

function Login({ notice, onStep }: { notice?: string; onStep: (s: Step) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const f = useForm(async () => onStep(await authCall<Step>('/auth/login', { email, password })));
  return (
    <Card title="Admin sign-in" intro="Authorised staff only. All actions are recorded.">
      <form onSubmit={f.submit} className="grid gap-3">
        {notice && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{notice}</p>}
        <label className="text-sm text-slate-600" htmlFor="em">Email</label>
        <input id="em" type="email" required autoComplete="username" className="field" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label className="text-sm text-slate-600" htmlFor="pw">Password</label>
        <input id="pw" type="password" required autoComplete="current-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorNote err={f.err} />
        <button className="btn-primary" disabled={f.busy}>{f.busy ? 'Checking…' : 'Continue'}</button>
      </form>
    </Card>
  );
}

function Setup({ token, onStep }: { token: string; onStep: (s: Step) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const f = useForm(async () => {
    if (password !== again) throw new Error('The two passwords do not match.');
    onStep(await authCall<Step>('/auth/setup', { token, password }));
  });
  return (
    <Card title="Set up your admin account" intro="Choose a strong password (12+ characters). Next you will register an authenticator app.">
      <form onSubmit={f.submit} className="grid gap-3">
        <label className="text-sm text-slate-600" htmlFor="np">New password</label>
        <input id="np" type="password" required minLength={12} autoComplete="new-password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="text-sm text-slate-600" htmlFor="np2">Repeat password</label>
        <input id="np2" type="password" required minLength={12} autoComplete="new-password" className="field" value={again} onChange={(e) => setAgain(e.target.value)} />
        <ErrorNote err={f.err} />
        <button className="btn-primary" disabled={f.busy}>Continue</button>
      </form>
    </Card>
  );
}

const restartable = (e: unknown) => e instanceof ApiError && e.code === 'INVALID_PREAUTH';

function Mfa({ pre, onSession, onRestart }: { pre: string; onSession: (s: Session) => void; onRestart: (n: string) => void }) {
  const [code, setCode] = useState('');
  const f = useForm(async () => {
    try { onSession(await authCall<Session>('/auth/mfa', { preAuthToken: pre, code: code.trim() })); }
    catch (e) { if (restartable(e)) onRestart('That sign-in took too long. Please start again.'); else throw e; }
  });
  return (
    <Card title="Enter your code" intro="Open your authenticator app and type the 6-digit code. Lost your phone? Use one of your recovery codes instead.">
      <form onSubmit={f.submit} className="grid gap-3">
        <label className="text-sm text-slate-600" htmlFor="code">Authenticator or recovery code</label>
        <input id="code" required autoFocus inputMode="text" autoComplete="one-time-code" className="field text-center font-mono text-lg tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorNote err={f.err} />
        <button className="btn-primary" disabled={f.busy || code.trim().length < 6}>{f.busy ? 'Checking…' : 'Sign in'}</button>
      </form>
    </Card>
  );
}

function Enroll({ pre, secret, uri, onSession, onRestart }: { pre: string; secret: string; uri: string; onSession: (s: Session) => void; onRestart: (n: string) => void }) {
  const [code, setCode] = useState('');
  const f = useForm(async () => {
    try { onSession(await authCall<Session>('/auth/enroll', { preAuthToken: pre, code: code.trim() })); }
    catch (e) { if (restartable(e)) onRestart('That sign-in took too long. Please start again.'); else throw e; }
  });
  return (
    <Card title="Register an authenticator app" intro="Admin accounts require a second step. In an authenticator app (Google Authenticator, 1Password, Authy…) add an account using this key, then enter the code it shows.">
      <p className="rounded-lg bg-slate-100 p-3 text-center font-mono text-sm tracking-wider" aria-label="Setup key">{secret.match(/.{1,4}/g)?.join(' ')}</p>
      <a className="text-center text-sm text-indigo-600 underline" href={uri}>Open in an authenticator app on this device</a>
      <form onSubmit={f.submit} className="grid gap-3">
        <label className="text-sm text-slate-600" htmlFor="ecode">6-digit code</label>
        <input id="ecode" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="field text-center font-mono text-lg tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorNote err={f.err} />
        <button className="btn-primary" disabled={f.busy || code.trim().length !== 6}>Verify and finish</button>
      </form>
    </Card>
  );
}

function Recovery({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Save your recovery codes" intro="If you lose your phone, each of these works once instead of an authenticator code. They are shown only now and cannot be retrieved later.">
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-3 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(codes.join('\n')).catch(() => {})}>Copy all</button>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I stored these somewhere safe (a password manager, not a shared document).</label>
      <button className="btn-primary" disabled={!saved} onClick={onDone}>Continue to the dashboard</button>
    </Card>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview', perm: 'stats:read' }, { id: 'users', label: 'Users', perm: 'users:read' }, { id: 'rooms', label: 'Rooms', perm: 'rooms:read' },
  { id: 'reports', label: 'Reports', perm: 'reports:read' }, { id: 'safety', label: 'Safety', perm: 'alerts:read' }, { id: 'settings', label: 'Settings', perm: 'settings:read' },
  { id: 'audit', label: 'Audit log', perm: 'audit:read' }, { id: 'admins', label: 'Admins', perm: 'admins:manage' },
] as const;

function Shell({ admin, onLogout }: { admin: Admin; onLogout: (notice?: string) => void }) {
  const tabs = TABS.filter((t) => can(admin.role, t.perm));
  const [tab, setTab] = useState<string>(tabs[0]?.id ?? 'overview');
  const last = useRef(Date.now());

  // Keep the session alive only while someone is actually using it. Idle for 25 minutes = signed out (the server also ends it at 30).
  useEffect(() => {
    const bump = () => { last.current = Date.now(); };
    const events = ['mousemove', 'keydown', 'click', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(async () => {
      if (Date.now() - last.current > 25 * 60 * 1000) { await signOut(); onLogout('You were signed out after 25 minutes of inactivity.'); return; }
      if (!(await tryRefresh())) onLogout('Your session ended. Please sign in again.');
    }, 8 * 60 * 1000);
    return () => { events.forEach((e) => window.removeEventListener(e, bump)); clearInterval(timer); };
  }, [onLogout]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <div><span className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Our Space</span><span className="ml-2 font-semibold">Admin</span></div>
          <div className="flex items-center gap-3 text-sm"><span className="text-slate-600">{admin.email} · {admin.role}</span><button className="btn-ghost" onClick={async () => { await signOut(); onLogout(); }}>Sign out</button></div>
        </div>
        <nav aria-label="Sections" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
          {tabs.map((t) => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>{t.label}</button>)}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5">
        <p className="mb-4 rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-900">Admins see account and room <strong>metadata</strong> only. Messages, photos, voice notes, drawings and locations are end-to-end encrypted and cannot be opened from here.</p>
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <Users admin={admin} />}
        {tab === 'rooms' && <Rooms admin={admin} />}
        {tab === 'reports' && <Reports admin={admin} />}
        {tab === 'safety' && <Safety />}
        {tab === 'settings' && <SettingsPanel admin={admin} />}
        {tab === 'audit' && <Audit />}
        {tab === 'admins' && <AdminsPanel admin={admin} />}
      </main>
    </div>
  );
}
