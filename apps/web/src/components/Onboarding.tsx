'use client';
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Heart, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Couple, Invitation } from '@/lib/types';

type Props = { couple: Couple | null; onChange: () => void | Promise<void> };

export default function Onboarding({ couple, onChange }: Props) {
  const [name, setName] = useState('Our Space');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<string | null>(null); // plaintext invite code, shown once
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (couple) setInvites((await api<{ invitations: Invitation[] }>('/couples/me/invitations')).invitations);
      else setWaiting((await api<{ invitations: unknown[] }>('/invitations/mine')).invitations.length > 0);
    } catch { /* transient */ }
  }, [couple]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function run(fn: () => Promise<void>) {
    setErr(null);
    setBusy(true);
    try { await fn(); await refresh(); await onChange(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Something went wrong'); }
    finally { setBusy(false); }
  }

  const copy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto grid max-w-xl gap-5 px-5 py-10">
      <div className="text-center">
        <Heart className="mx-auto mb-3 h-9 w-9 fill-accent text-accent" aria-hidden />
        <h1 className="text-2xl font-semibold">{couple ? couple.name : 'Welcome — let’s set up your space'}</h1>
        <p className="mt-1 text-muted">{couple ? 'Invite your partner. Nobody joins until you confirm them.' : 'Start a room, or join your partner’s with their invite code.'}</p>
      </div>
      {err && <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}

      {!couple && !waiting && (
        <>
          <section className="card grid gap-3" aria-labelledby="create-h">
            <h2 id="create-h" className="font-medium">Start a new space</h2>
            <label className="label" htmlFor="room">Room name</label>
            <input id="room" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary" disabled={busy || !name.trim()} onClick={() => run(async () => { await api('/couples', { method: 'POST', body: { name: name.trim() } }); })}>Create our space</button>
          </section>
          <section className="card grid gap-3" aria-labelledby="join-h">
            <h2 id="join-h" className="font-medium">I have an invite code</h2>
            <label className="label" htmlFor="code">Invite code</label>
            <input id="code" className="input tracking-widest" placeholder="ABCDE-FGHJK" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn-ghost" disabled={busy || code.trim().length < 10} onClick={() => run(async () => { await api('/invitations/accept', { method: 'POST', body: { code: code.trim() } }); setCode(''); })}>Send join request</button>
          </section>
        </>
      )}

      {!couple && waiting && (
        <section className="card text-center" aria-live="polite">
          <p className="font-medium">Request sent 💌</p>
          <p className="mt-1 text-muted">Waiting for your partner to confirm you. This page updates by itself.</p>
        </section>
      )}

      {couple && (
        <>
          {issued && (
            <section className="card grid gap-2 text-center" aria-live="polite">
              <p className="text-sm text-muted">Share this code privately. It is shown only once and expires in 72 hours.</p>
              <p className="select-all text-3xl font-semibold tracking-widest">{issued}</p>
              <button className="btn-ghost mx-auto" onClick={copy}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy code'}</button>
            </section>
          )}
          <button className="btn-primary" disabled={busy} onClick={() => run(async () => { setIssued((await api<{ code: string }>('/couples/me/invitations', { method: 'POST' })).code); })}>Create invite code</button>

          {invites.length > 0 && (
            <section className="card grid gap-3" aria-labelledby="inv-h">
              <h2 id="inv-h" className="font-medium">Invitations</h2>
              {invites.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line p-3">
                  {i.status === 'accepted' && i.invitee ? (
                    <>
                      <span><strong>{i.invitee.displayName}</strong> (@{i.invitee.username}) wants to join. Is this your partner?</span>
                      <span className="flex gap-2">
                        <button className="btn-primary" disabled={busy} onClick={() => run(async () => { await api(`/couples/me/invitations/${i.id}/confirm`, { method: 'POST' }); })}>Confirm</button>
                        <button className="btn-ghost" disabled={busy} onClick={() => run(async () => { await api(`/couples/me/invitations/${i.id}/reject`, { method: 'POST' }); })}>Decline</button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted">Unused code · expires {new Date(i.expiresAt).toLocaleString()}</span>
                      <button className="btn-ghost" aria-label="Revoke invitation" disabled={busy} onClick={() => run(async () => { await api(`/couples/me/invitations/${i.id}`, { method: 'DELETE' }); })}><X className="h-4 w-4" />Revoke</button>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
          <button className="text-sm text-muted underline" disabled={busy} onClick={() => { if (confirm('Delete this room?')) run(async () => { await api('/couples/me/leave', { method: 'POST' }); setIssued(null); }); }}>Delete this room</button>
        </>
      )}
    </div>
  );
}
