'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, say, type Admin } from '@/lib/api';
import { can } from '@/lib/perms';
import { Badge, Drawer, ErrorNote, Panel, ReasonDialog, Row, Table, fmtBytes, fmtDate, useLoad } from '../ui';

type UserRow = { id: string; username: string; email: string; status: string; createdAt: string; lastLoginAt: string | null; emailVerified: boolean; inRoom: boolean; reportsAgainst: number };
type UserDetail = UserRow & {
  displayName: string | null; suspension: { reason: string; at: string; by: string } | null; deletionScheduledAt: string | null; devices: number; activeSessions: number;
  room: { id: string; status: string } | null; blocking: number; blockedBy: number; reportsFiled: number; reportsAgainst: { id: string; category: string; status: string; createdAt: string }[];
};

export function useList<R>(path: string, key: string, filters: Record<string, string>) {
  const [rows, setRows] = useState<R[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (reset: boolean, before?: string | null) => {
    setLoading(true);
    try {
      const r = await api<Record<string, unknown>>(path, { query: { ...filters, before: reset ? undefined : before ?? undefined, limit: 25 } });
      const items = r[key] as R[];
      setRows((l) => (reset ? items : [...l, ...items]));
      setNext((r.nextBefore as string | null) ?? null);
      setErr(null);
    } catch (e) { setErr(say(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, JSON.stringify(filters)]);
  return { rows, next, err, loading, load };
}

export function Users({ admin }: { admin: Admin }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const list = useList<UserRow>('/users', 'users', applied);
  useEffect(() => { void list.load(true); }, [list.load]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = (e: FormEvent) => { e.preventDefault(); setApplied({ ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) }); };
  return (
    <Panel title="Users">
      <form onSubmit={search} className="mb-3 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="uq">Search</label>
        <input id="uq" className="field max-w-xs" placeholder="Username, email start, or user id" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="us">Status</label>
        <select id="us" className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="pending_deletion">Pending deletion</option>
        </select>
        <button className="btn-primary">Search</button>
      </form>
      <ErrorNote err={list.err} />
      <Table head={['Username', 'Email', 'Status', 'Joined', 'Last sign-in', 'In room', 'Reports']}>
        {list.rows.map((u) => (
          <tr key={u.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(u.id)}>
            <td className="td font-medium"><button className="underline-offset-2 hover:underline" onClick={() => setOpen(u.id)}>@{u.username}</button></td><td className="td">{u.email}</td><td className="td"><Badge value={u.status} /></td>
            <td className="td">{fmtDate(u.createdAt)}</td><td className="td">{fmtDate(u.lastLoginAt)}</td><td className="td">{u.inRoom ? 'yes' : 'no'}</td><td className="td">{u.reportsAgainst || ''}</td>
          </tr>
        ))}
      </Table>
      {!list.loading && list.rows.length === 0 && <p className="py-4 text-center text-sm text-slate-500">No users found.</p>}
      {list.next && <div className="mt-3 text-center"><button className="btn-ghost" disabled={list.loading} onClick={() => list.load(false, list.next)}>Load more</button></div>}
      {open && <UserDrawer id={open} admin={admin} onClose={() => setOpen(null)} onChanged={() => list.load(true)} />}
    </Panel>
  );
}

function UserDrawer({ id, admin, onClose, onChanged }: { id: string; admin: Admin; onClose: () => void; onChanged: () => void }) {
  const { data: u, err, reload } = useLoad(() => api<UserDetail>(`/users/${id}`), [id]);
  const [dialog, setDialog] = useState<'suspend' | 'reactivate' | null>(null);
  const act = (kind: 'suspend' | 'reactivate') => async (reason: string) => { await api(`/users/${id}/${kind}`, { method: 'POST', body: { reason } }); setDialog(null); await reload(); onChanged(); };
  return (
    <Drawer title={u ? `@${u.username}` : 'User'} onClose={onClose}>
      <ErrorNote err={err} />
      {u && (
        <>
          <Panel>
            <Row k="Status" v={<Badge value={u.status} />} /><Row k="Email" v={`${u.email}${u.emailVerified ? ' ✓' : ' (unverified)'}`} /><Row k="Display name" v={u.displayName ?? '—'} />
            <Row k="Joined" v={fmtDate(u.createdAt)} /><Row k="Last sign-in" v={fmtDate(u.lastLoginAt)} /><Row k="Devices" v={u.devices} /><Row k="Active sessions" v={u.activeSessions} />
            <Row k="Room" v={u.room ? <>{u.room.status} · <code className="text-xs">{u.room.id}</code></> : 'none'} /><Row k="Blocking / blocked by" v={`${u.blocking} / ${u.blockedBy}`} /><Row k="Reports filed" v={u.reportsFiled} />
            {u.deletionScheduledAt && <Row k="Deletion scheduled" v={fmtDate(u.deletionScheduledAt)} />}
            {u.suspension && <Row k="Suspension" v={<span>{u.suspension.reason}<br /><span className="text-xs text-slate-500">by {u.suspension.by} · {fmtDate(u.suspension.at)}</span></span>} />}
          </Panel>
          <Panel title="Reports against this user">
            {u.reportsAgainst.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="grid gap-1 text-sm">{u.reportsAgainst.map((r) => <li key={r.id} className="flex justify-between"><span>{r.category.replace('_', ' ')} · {fmtDate(r.createdAt)}</span><Badge value={r.status} /></li>)}</ul>}
          </Panel>
          {can(admin.role, 'users:suspend') && (
            <div className="flex gap-2">
              {u.status === 'active' && <button className="btn-danger" onClick={() => setDialog('suspend')}>Suspend account</button>}
              {u.status === 'suspended' && <button className="btn-primary" onClick={() => setDialog('reactivate')}>Reactivate account</button>}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">This is everything admins can see. Message and media contents are encrypted end to end.</p>
        </>
      )}
      {dialog === 'suspend' && <ReasonDialog danger title="Suspend this account?" confirmLabel="Suspend" extra={<p className="mb-2 text-sm text-slate-600">They are signed out of every device immediately and cannot sign in until reactivated.</p>} onCancel={() => setDialog(null)} onSubmit={act('suspend')} />}
      {dialog === 'reactivate' && <ReasonDialog title="Reactivate this account?" confirmLabel="Reactivate" onCancel={() => setDialog(null)} onSubmit={act('reactivate')} />}
    </Drawer>
  );
}

type RoomRow = { id: string; status: string; createdAt: string; activatedAt: string | null; closedAt: string | null; keyVersion: number; storageUsedBytes: number; members: { id: string; username: string | null }[]; suspension: { reason: string; at: string; by: string } | null };
type RoomDetail = RoomRow & { counts: Record<string, number> };

export function Rooms({ admin }: { admin: Admin }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const list = useList<RoomRow>('/rooms', 'rooms', applied);
  useEffect(() => { void list.load(true); }, [list.load]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = (e: FormEvent) => { e.preventDefault(); setApplied({ ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) }); };
  return (
    <Panel title="Rooms">
      <form onSubmit={search} className="mb-3 flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="rq">Search</label>
        <input id="rq" className="field max-w-xs" placeholder="Member username or room id" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="rs">Status</label>
        <select id="rs" className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>{['pending', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn-primary">Search</button>
      </form>
      <ErrorNote err={list.err} />
      <Table head={['Room', 'Members', 'Status', 'Created', 'Storage']}>
        {list.rows.map((r) => (
          <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r.id)}>
            <td className="td font-mono text-xs"><button className="underline-offset-2 hover:underline" onClick={() => setOpen(r.id)}>{r.id.slice(-8)}</button></td>
            <td className="td">{r.members.map((m) => `@${m.username ?? '?'}`).join(' & ')}</td><td className="td"><Badge value={r.status} /></td><td className="td">{fmtDate(r.createdAt)}</td><td className="td">{fmtBytes(r.storageUsedBytes)}</td>
          </tr>
        ))}
      </Table>
      {!list.loading && list.rows.length === 0 && <p className="py-4 text-center text-sm text-slate-500">No rooms found.</p>}
      {list.next && <div className="mt-3 text-center"><button className="btn-ghost" disabled={list.loading} onClick={() => list.load(false, list.next)}>Load more</button></div>}
      {open && <RoomDrawer id={open} admin={admin} onClose={() => setOpen(null)} onChanged={() => list.load(true)} />}
    </Panel>
  );
}

function RoomDrawer({ id, admin, onClose, onChanged }: { id: string; admin: Admin; onClose: () => void; onChanged: () => void }) {
  const { data: r, err, reload } = useLoad(() => api<RoomDetail>(`/rooms/${id}`), [id]);
  const [dialog, setDialog] = useState<'suspend' | 'reactivate' | null>(null);
  const act = (kind: 'suspend' | 'reactivate') => async (reason: string) => { await api(`/rooms/${id}/${kind}`, { method: 'POST', body: { reason } }); setDialog(null); await reload(); onChanged(); };
  return (
    <Drawer title="Room" onClose={onClose}>
      <ErrorNote err={err} />
      {r && (
        <>
          <Panel>
            <Row k="Status" v={<Badge value={r.status} />} /><Row k="Members" v={r.members.map((m) => `@${m.username ?? '?'}`).join(' & ')} /><Row k="Created" v={fmtDate(r.createdAt)} />
            <Row k="Activated" v={fmtDate(r.activatedAt)} /><Row k="Closed" v={fmtDate(r.closedAt)} /><Row k="Key version" v={r.keyVersion} /><Row k="Storage" v={fmtBytes(r.storageUsedBytes)} />
            {r.suspension && <Row k="Suspension" v={<span>{r.suspension.reason}<br /><span className="text-xs text-slate-500">by {r.suspension.by} · {fmtDate(r.suspension.at)}</span></span>} />}
          </Panel>
          <Panel title="Activity (counts only)">{Object.entries(r.counts).map(([k, v]) => <Row key={k} k={k.replace(/([A-Z])/g, ' $1').toLowerCase()} v={v} />)}</Panel>
          {can(admin.role, 'rooms:suspend') && (
            <div className="flex gap-2">
              {['active', 'pending'].includes(r.status) && <button className="btn-danger" onClick={() => setDialog('suspend')}>Suspend room</button>}
              {r.status === 'suspended' && <button className="btn-primary" onClick={() => setDialog('reactivate')}>Reactivate room</button>}
            </div>
          )}
          <p className="mt-3 text-xs text-slate-500">Admins cannot read messages, memories, drawings, files or calls. Those are end-to-end encrypted, and no permission can open them.</p>
        </>
      )}
      {dialog === 'suspend' && <ReasonDialog danger title="Suspend this room?" confirmLabel="Suspend" extra={<p className="mb-2 text-sm text-slate-600">Both partners lose access until it is reactivated. Their data is not deleted.</p>} onCancel={() => setDialog(null)} onSubmit={act('suspend')} />}
      {dialog === 'reactivate' && <ReasonDialog title="Reactivate this room?" confirmLabel="Reactivate" onCancel={() => setDialog(null)} onSubmit={act('reactivate')} />}
    </Drawer>
  );
}
