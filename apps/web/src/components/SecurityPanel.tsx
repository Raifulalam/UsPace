'use client';
import { useState } from 'react';
import { ShieldCheck, Smartphone, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import type { E2EE } from '@/lib/e2ee';
import type { SyncState } from '@/lib/types';
import RecoveryKeyDialog from './RecoveryKeyDialog';

type Props = { e2ee: E2EE; state: SyncState; hasBackup: boolean | null; onClose: () => void; onChanged: () => Promise<void> };

export default function SecurityPanel({ e2ee, state, hasBackup, onClose, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rk, setRk] = useState<string | null>(null);
  const [existing, setExisting] = useState('');
  const [note, setNote] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setErr(null); setNote(null); setBusy(true);
    try { await fn(); await onChanged(); } catch (e) { setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  return (
    <aside role="dialog" aria-modal="true" aria-labelledby="sec-h" className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto border-l border-line bg-bg p-5 shadow-soft">
      <div className="mb-4 flex items-center justify-between">
        <h2 id="sec-h" className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="h-5 w-5 text-accent2" aria-hidden />Security</h2>
        <button className="btn-ghost" aria-label="Close security panel" onClick={onClose}><X className="h-4 w-4" /></button>
      </div>
      {err && <p role="alert" className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}
      {note && <p role="status" className="mb-3 rounded-xl bg-accent2/10 px-3 py-2 text-sm">{note}</p>}

      <section className="card mb-4 grid gap-2">
        <h3 className="font-medium">Room safety number</h3>
        <p className="text-sm text-muted">Compare this with your partner in person or on a call. If it ever differs, someone may be tampering with your keys; don’t trust new messages until you’ve checked.</p>
        <p className="rounded-2xl bg-bg/70 p-3 text-center font-mono text-lg tracking-wider" aria-label="Safety number">{e2ee.roomCode(state.devices)}</p>
      </section>

      <section className="card mb-4 grid gap-3">
        <h3 className="font-medium">Devices</h3>
        {state.devices.map((d) => (
          <div key={d.id} className="flex items-center justify-between gap-2 rounded-2xl border border-line p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate"><Smartphone className="h-4 w-4 shrink-0" aria-hidden />{d.label}{d.id === e2ee.device.id && <span className="rounded-full bg-accent2/20 px-2 text-xs">this device</span>}</p>
              <p className="text-xs text-muted">{d.isMine ? 'You' : 'Your partner'} · {d.hasKey ? 'can read messages' : 'waiting for approval'}</p>
            </div>
            {d.isMine && (
              <button className="btn-ghost shrink-0" disabled={busy} onClick={() => {
                if (confirm(`Remove “${d.label}”? The room key will be rotated so it can’t read new messages.`)) run(async () => { await e2ee.revokeAndRotate(d.id); setNote('Device removed and key rotated.'); });
              }}>Remove</button>
            )}
          </div>
        ))}
      </section>

      <section className="card grid gap-3">
        <h3 className="font-medium">Recovery key</h3>
        <p className="text-sm text-muted">{hasBackup ? 'A backup exists. After a device is removed (key rotation) refresh it with your existing key, or create a new key.' : 'No backup yet. Without one, losing all your devices means losing your history.'}</p>
        <button className="btn-primary" disabled={busy} onClick={() => run(async () => { setRk(await e2ee.createRecovery()); })}>{hasBackup ? 'Create a new recovery key' : 'Create recovery key'}</button>
        {hasBackup && (
          <>
            <label className="label" htmlFor="rk-existing">Refresh backup with your existing key</label>
            <input id="rk-existing" className="input font-mono" placeholder="XXXX-XXXX-…" value={existing} onChange={(e) => setExisting(e.target.value)} />
            <button className="btn-ghost" disabled={busy || existing.length < 20} onClick={() => run(async () => { await e2ee.refreshBackup(existing); setExisting(''); setNote('Backup refreshed.'); })}>Refresh backup</button>
          </>
        )}
      </section>
      {rk && <RecoveryKeyDialog text={rk} onDone={() => setRk(null)} />}
    </aside>
  );
}
