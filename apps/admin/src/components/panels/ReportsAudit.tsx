'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api, say, type Admin } from '@/lib/api';
import { can } from '@/lib/perms';
import { Badge, Drawer, ErrorNote, Panel, ReasonDialog, Row, Table, fmtDate, useLoad } from '../ui';
import { useList } from './UsersRooms';

type ReportRow = { id: string; category: string; status: string; createdAt: string; reporter: string | null; target: string; targetUserId: string | null; roomId: string | null };
type ReportDetail = ReportRow & { details: string; evidence: string; resolution: string | null; handledAt: string | null };

export function Reports({ admin }: { admin: Admin }) {
  const [status, setStatus] = useState('open');
  const [open, setOpen] = useState<string | null>(null);
  const list = useList<ReportRow>('/reports', 'reports', status ? { status } : {});
  useEffect(() => { void list.load(true); }, [list.load]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Panel title="Reports" actions={
      <><label className="sr-only" htmlFor="rf">Status</label>
        <select id="rf" className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{['open', 'reviewing', 'actioned', 'dismissed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select></>
    }>
      <ErrorNote err={list.err} />
      <Table head={['Reported', 'Category', 'Reporter', 'Target', 'Status']}>
        {list.rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r.id)}>
            <td className="td"><button className="underline-offset-2 hover:underline" onClick={() => setOpen(r.id)}>{fmtDate(r.createdAt)}</button></td><td className="td">{r.category.replace('_', ' ')}</td>
            <td className="td">@{r.reporter ?? '?'}</td><td className="td">@{r.target}</td><td className="td"><Badge value={r.status} /></td>
          </tr>
        ))}
      </Table>
      {!list.loading && list.rows.length === 0 && <p className="py-4 text-center text-sm text-slate-500">No reports here.</p>}
      {list.next && <div className="mt-3 text-center"><button className="btn-ghost" disabled={list.loading} onClick={() => list.load(false, list.next)}>Load more</button></div>}
      {open && <ReportDrawer id={open} admin={admin} onClose={() => setOpen(null)} onChanged={() => list.load(true)} />}
    </Panel>
  );
}

function ReportDrawer({ id, admin, onClose, onChanged }: { id: string; admin: Admin; onClose: () => void; onChanged: () => void }) {
  const { data: r, err, reload } = useLoad(() => api<ReportDetail>(`/reports/${id}`), [id]);
  const [action, setAction] = useState<null | { status: 'reviewing' | 'actioned' | 'dismissed'; label: string }>(null);
  return (
    <Drawer title="Report" onClose={onClose}>
      <ErrorNote err={err} />
      {r && (
        <>
          <Panel>
            <Row k="Status" v={<Badge value={r.status} />} /><Row k="Category" v={r.category.replace('_', ' ')} /><Row k="Reported" v={fmtDate(r.createdAt)} />
            <Row k="Reporter" v={`@${r.reporter ?? '?'}`} /><Row k="Reported person" v={`@${r.target}`} />
            {r.roomId && <Row k="Room" v={<code className="text-xs">{r.roomId}</code>} />}
            {r.handledAt && <Row k="Handled" v={fmtDate(r.handledAt)} />}{r.resolution && <Row k="Resolution" v={r.resolution} />}
          </Panel>
          <Panel title="What the reporter wrote"><p className="whitespace-pre-wrap text-sm">{r.details || '—'}</p></Panel>
          <Panel title="Text the reporter chose to share">
            <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Unverified. Messages are end-to-end encrypted, so we cannot confirm this text is real or complete.</p>
            <p className="whitespace-pre-wrap text-sm">{r.evidence || '—'}</p>
          </Panel>
          {can(admin.role, 'reports:handle') && (
            <div className="flex flex-wrap gap-2">
              {r.status === 'open' && <button className="btn-ghost" onClick={() => setAction({ status: 'reviewing', label: 'Start review' })}>Start review</button>}
              <button className="btn-primary" onClick={() => setAction({ status: 'actioned', label: 'Mark action taken' })}>Action taken</button>
              <button className="btn-ghost" onClick={() => setAction({ status: 'dismissed', label: 'Dismiss report' })}>Dismiss</button>
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">To act on the accounts or room, find them under Users / Rooms (search by the username or room id shown above).</p>
        </>
      )}
      {action && <ReasonDialog title={action.label} confirmLabel={action.label} onCancel={() => setAction(null)} onSubmit={async (reason) => { await api(`/reports/${id}/handle`, { method: 'POST', body: { status: action.status, resolution: reason } }); setAction(null); await reload(); onChanged(); }} />}
    </Drawer>
  );
}

type Entry = { seq: number; at: string; admin: string | null; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown>; ip: string | null };

export function Audit() {
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<string | null>(null);

  const load = async (reset: boolean) => {
    try {
      const r = await api<{ entries: Entry[]; nextBefore: number | null }>('/audit', { query: { action: applied || undefined, before: reset ? undefined : next ?? undefined, limit: 50 } });
      setEntries((l) => (reset ? r.entries : [...l, ...r.entries])); setNext(r.nextBefore); setErr(null);
    } catch (e) { setErr(say(e)); }
  };
  useEffect(() => { void load(true); }, [applied]); // eslint-disable-line react-hooks/exhaustive-deps
  const check = async () => {
    setVerify('Checking…');
    try {
      const v = await api<{ ok: boolean; entries?: number; head?: string; brokenAtSeq?: number; reason?: string }>('/audit/verify');
      setVerify(v.ok ? `Intact: ${v.entries} entries verified. Chain head ${v.head?.slice(0, 16)}…` : `TAMPERING DETECTED at entry #${v.brokenAtSeq}: ${v.reason}`);
    } catch (e) { setVerify(say(e)); }
  };
  return (
    <Panel title="Audit log" actions={<button className="btn-ghost" onClick={check}>Verify integrity</button>}>
      <p className="mb-3 text-xs text-slate-500">Append-only. Each entry is cryptographically chained to the one before it, so editing or removing history is detectable.</p>
      {verify && <p role="status" className={`mb-3 rounded-lg px-3 py-2 text-sm ${verify.startsWith('TAMPERING') ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{verify}</p>}
      <form className="mb-3 flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setApplied(action.trim()); }}>
        <label className="sr-only" htmlFor="aa">Action</label>
        <input id="aa" className="field max-w-xs" placeholder="Filter by action, e.g. users.suspend" value={action} onChange={(e) => setAction(e.target.value)} />
        <button className="btn-ghost">Filter</button>
      </form>
      <ErrorNote err={err} />
      <Table head={['#', 'When', 'Admin', 'Action', 'Target', 'Details']}>
        {entries.map((e) => (
          <tr key={e.seq} className="align-top">
            <td className="td text-slate-500">{e.seq}</td><td className="td whitespace-nowrap">{fmtDate(e.at)}</td><td className="td">{e.admin ?? '—'}</td>
            <td className="td font-mono text-xs">{e.action}</td><td className="td text-xs">{e.targetType ? `${e.targetType} ${e.targetId?.slice(-8) ?? ''}` : ''}</td>
            <td className="td max-w-xs break-words text-xs text-slate-600">{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td>
          </tr>
        ))}
      </Table>
      {next && <div className="mt-3 text-center"><button className="btn-ghost" onClick={() => load(false)}>Load older</button></div>}
    </Panel>
  );
}
