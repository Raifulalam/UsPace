'use client';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

function Shell({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-md content-center gap-5 px-5 py-10">
      <div className="text-center"><h1 className="text-2xl font-semibold">{title}</h1><p className="mt-1 text-muted">{intro}</p></div>
      {children}
      <p className="text-center text-sm"><Link className="text-accent2 underline" href="/login">Back to log in</Link></p>
    </main>
  );
}
const msg = (e: unknown) => (e instanceof ApiError ? (Array.isArray(e.details) && e.details.length ? (e.details as { message: string }[]).map((d) => d.message).join(' · ') : e.message) : 'Could not reach the server.');

function useSubmit(run: () => Promise<string>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { setDone(await run()); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return { busy, err, done, submit };
}
const Feedback = ({ err, done }: { err: string | null; done: string | null }) => (
  <>
    {err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
    {done && <p role="status" className="rounded-xl bg-accent2/10 px-3 py-2 text-sm">{done}</p>}
  </>
);

export function ForgotForm() {
  const [email, setEmail] = useState('');
  const f = useSubmit(async () => { await api('/auth/password/forgot', { method: 'POST', body: { email } }); return 'If that email has an account, a reset link is on its way. It is valid for one hour.'; });
  return (
    <Shell title="Reset your password" intro="Enter your email and we’ll send you a link.">
      <form onSubmit={f.submit} className="card grid gap-4">
        <div><label className="label" htmlFor="fe">Email</label><input id="fe" type="email" required className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <Feedback err={f.err} done={f.done} />
        <button className="btn-primary" disabled={f.busy}>{f.busy ? 'Sending…' : 'Send reset link'}</button>
      </form>
    </Shell>
  );
}

export function ResetForm() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') ?? ''); }, []);
  const f = useSubmit(async () => { await api('/auth/password/reset', { method: 'POST', body: { token, password } }); return 'Password changed. You were signed out everywhere; log in with your new password. Your encrypted history is not affected.'; });
  return (
    <Shell title="Choose a new password" intro="At least 10 characters.">
      <form onSubmit={f.submit} className="card grid gap-4">
        <div><label className="label" htmlFor="rp">New password</label><input id="rp" type="password" required minLength={10} className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {!token && <p role="alert" className="text-sm text-red-500">This page needs the link from your email.</p>}
        <Feedback err={f.err} done={f.done} />
        <button className="btn-primary" disabled={f.busy || !token}>{f.busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Shell>
  );
}

export function RestoreForm() {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const f = useSubmit(async () => { await api('/auth/deletion/cancel', { method: 'POST', body: { identifier, password } }); return 'Your account is restored. You can log in now. (If you were in a room, it was closed when you deleted your account.)'; });
  return (
    <Shell title="Restore your account" intro="Deleted accounts can be restored for 14 days.">
      <form onSubmit={f.submit} className="card grid gap-4">
        <div><label className="label" htmlFor="ri">Username or email</label><input id="ri" required className="input" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></div>
        <div><label className="label" htmlFor="rw">Password</label><input id="rw" type="password" required className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <Feedback err={f.err} done={f.done} />
        <button className="btn-primary" disabled={f.busy}>{f.busy ? 'Restoring…' : 'Restore account'}</button>
      </form>
    </Shell>
  );
}
