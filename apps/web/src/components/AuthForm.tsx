'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Heart } from 'lucide-react';
import { useAuth } from '@/lib/session';
import { ApiError } from '@/lib/api';

function explain(e: unknown): string {
  if (e instanceof ApiError && e.code === 'ACCOUNT_SUSPENDED') return 'This account is suspended or scheduled for deletion. If you deleted it by mistake you can restore it within 14 days.';
  if (!(e instanceof ApiError)) return 'Could not reach the server. Is it running?';
  if (Array.isArray(e.details) && e.details.length) return e.details.map((d: { path: string; message: string }) => `${d.path}: ${d.message}`).join(' · ');
  return e.message;
}

export default function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { login, register, status } = useAuth();
  const router = useRouter();
  const [f, setF] = useState({ identifier: '', username: '', email: '', password: '', birthDate: '', displayName: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  useEffect(() => { if (status === 'authed') router.replace('/space'); }, [status, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(f.identifier, f.password);
      else await register({ username: f.username, email: f.email, password: f.password, birthDate: f.birthDate, ...(f.displayName.trim() ? { displayName: f.displayName.trim() } : {}) });
    } catch (x) {
      setErr(explain(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-md content-center gap-6 px-5 py-10">
      <div className="text-center">
        <Heart className="mx-auto mb-3 h-10 w-10 fill-accent text-accent" aria-hidden />
        <h1 className="text-3xl font-semibold">Our Space</h1>
        <p className="mt-1 text-muted">A private, end-to-end encrypted place for two.</p>
      </div>
      <form onSubmit={submit} className="card grid gap-4" aria-label={mode === 'login' ? 'Log in' : 'Create account'}>
        {mode === 'login' ? (
          <div><label className="label" htmlFor="identifier">Username or email</label>
            <input id="identifier" className="input" autoComplete="username" required value={f.identifier} onChange={set('identifier')} /></div>
        ) : (
          <>
            <div><label className="label" htmlFor="username">Username</label>
              <input id="username" className="input" autoComplete="username" required pattern="[A-Za-z0-9_.]{3,24}" title="3-24 letters, numbers, _ or ." value={f.username} onChange={set('username')} /></div>
            <div><label className="label" htmlFor="displayName">Display name (optional)</label>
              <input id="displayName" className="input" maxLength={50} value={f.displayName} onChange={set('displayName')} /></div>
            <div><label className="label" htmlFor="email">Email</label>
              <input id="email" type="email" className="input" autoComplete="email" required value={f.email} onChange={set('email')} /></div>
            <div><label className="label" htmlFor="birthDate">Date of birth (18+ only)</label>
              <input id="birthDate" type="date" className="input" required value={f.birthDate} onChange={set('birthDate')} /></div>
          </>
        )}
        <div><label className="label" htmlFor="password">Password{mode === 'register' ? ' (10+ characters)' : ''}</label>
          <input id="password" type="password" className="input" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={mode === 'register' ? 10 : 1} value={f.password} onChange={set('password')} /></div>
        {err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
        <button className="btn-primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
      </form>
      <p className="text-center text-sm text-muted">
        {mode === 'login' && <><Link className="text-accent2 underline" href="/forgot">Forgot your password?</Link> · <Link className="text-accent2 underline" href="/restore">Restore a deleted account</Link><br /></>}
        {mode === 'login' ? <>New here? <Link className="text-accent2 underline" href="/register">Create an account</Link></> : <>Already have an account? <Link className="text-accent2 underline" href="/login">Log in</Link></>}
      </p>
    </main>
  );
}
