'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { say } from '@/lib/api';

export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

const TONES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800', pending: 'bg-amber-100 text-amber-800', suspended: 'bg-red-100 text-red-800',
  closed: 'bg-slate-200 text-slate-700', pending_deletion: 'bg-orange-100 text-orange-800', invited: 'bg-sky-100 text-sky-800', disabled: 'bg-slate-200 text-slate-700',
  open: 'bg-red-100 text-red-800', reviewing: 'bg-amber-100 text-amber-800', actioned: 'bg-emerald-100 text-emerald-800', dismissed: 'bg-slate-200 text-slate-700',
  high: 'bg-red-100 text-red-800', medium: 'bg-amber-100 text-amber-800', low: 'bg-sky-100 text-sky-800', info: 'bg-slate-200 text-slate-700',
};
export const Badge = ({ value }: { value: string }) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[value] ?? 'bg-slate-100 text-slate-700'}`}>{value.replace('_', ' ')}</span>;

export function Panel({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel mb-4">
      {(title || actions) && <div className="mb-3 flex items-center justify-between gap-2">{title && <h2 className="font-semibold">{title}</h2>}<div className="flex gap-2">{actions}</div></div>}
      {children}
    </section>
  );
}
export const ErrorNote = ({ err }: { err: string | null }) => (err ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p> : null);
export const Table = ({ head, children }: { head: string[]; children: ReactNode }) => (
  <div className="overflow-x-auto"><table className="w-full"><thead className="border-b border-slate-200"><tr>{head.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{children}</tbody></table></div>
);
export const Stat = ({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) => (
  <div className="panel"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p>{hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}</div>
);

/** Loads data on mount and whenever deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => { setLoading(true); try { setData(await fn()); setErr(null); } catch (e) { setErr(say(e)); } finally { setLoading(false); } }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, loading, reload };
}

/** Every suspend/reactivate/handle action asks for a written reason. It is stored in the audit log. */
export function ReasonDialog({ title, confirmLabel, danger, extra, onCancel, onSubmit }: {
  title: string; confirmLabel: string; danger?: boolean; extra?: ReactNode; onCancel: () => void; onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rd-h" className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
      <form className="panel w-full max-w-md" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await onSubmit(reason.trim()); } catch (x) { setErr(say(x)); setBusy(false); } }}>
        <h3 id="rd-h" className="mb-2 font-semibold">{title}</h3>
        {extra}
        <label className="mb-1 block text-sm text-slate-600" htmlFor="rd-reason">Reason (kept in the audit log)</label>
        <textarea id="rd-reason" required minLength={3} maxLength={500} rows={3} className="field" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        <ErrorNote err={err} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || reason.trim().length < 3}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside role="dialog" aria-modal="true" aria-label={title} className="fixed inset-y-0 right-0 z-40 w-full max-w-lg overflow-y-auto border-l border-slate-200 bg-slate-50 p-4 shadow-xl">
      <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">{title}</h2><button className="btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
      {children}
    </aside>
  );
}
export const Row = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 text-sm"><span className="text-slate-500">{k}</span><span className="text-right">{v}</span></div>;
