'use client';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, ErrorNote, Panel, Stat, Table, fmtBytes, useLoad } from '../ui';

type Stats = {
  users: { total: number; byStatus: Record<string, number>; newLast24h: number; newLast7d: number; newLast30d: number; dailyActive: number; monthlyActive: number };
  rooms: { byStatus: Record<string, number>; connectedCouples: number };
  pendingInvitations: number; openReports: number; storage: { usedBytes: number; files: number }; online: { users: number };
  health: { database: { ok: boolean; pingMs: number }; uptimeSeconds: number; memoryMb: number; calls: string };
  calls: { last24h: number; answeredLast24h: number; activeNow: number };
  subscriptions: { configured: boolean };
};

export function Overview() {
  const { data, err, reload } = useLoad(() => api<Stats>('/stats'), []);
  useEffect(() => { const t = setInterval(reload, 30000); return () => clearInterval(t); }, [reload]);
  const s = data;
  return (
    <>
      <ErrorNote err={err} />
      {s && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Registered users" value={s.users.total} hint={`${s.users.newLast24h} new today · ${s.users.newLast7d} this week`} />
            <Stat label="Connected couples" value={s.rooms.connectedCouples} hint={`${s.pendingInvitations} pending invitations`} />
            <Stat label="Active users" value={s.users.dailyActive} hint={`${s.users.monthlyActive} in the last 30 days`} />
            <Stat label="Online now" value={s.online.users} />
            <Stat label="Open reports" value={s.openReports} />
            <Stat label="Storage used" value={fmtBytes(s.storage.usedBytes)} hint={`${s.storage.files} encrypted files`} />
            <Stat label="Suspended users" value={s.users.byStatus.suspended ?? 0} hint={`${s.users.byStatus.pending_deletion ?? 0} pending deletion`} />
            <Stat label="Calls (24 h)" value={s.calls.last24h} hint={`${s.calls.answeredLast24h} answered · ${s.calls.activeNow} in progress`} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title="Rooms by status"><ul className="text-sm">{Object.entries(s.rooms.byStatus).map(([k, v]) => <li key={k} className="flex justify-between py-1"><Badge value={k} /><span>{v}</span></li>)}</ul></Panel>
            <Panel title="Service health">
              <ul className="grid gap-1 text-sm">
                <li className="flex justify-between"><span>API</span><Badge value="active" /></li>
                <li className="flex justify-between"><span>Database</span><span>{s.health.database.ok ? `ok · ${s.health.database.pingMs} ms` : 'down'}</span></li>
                <li className="flex justify-between"><span>Uptime</span><span>{Math.floor(s.health.uptimeSeconds / 3600)} h {Math.floor((s.health.uptimeSeconds % 3600) / 60)} m</span></li>
                <li className="flex justify-between"><span>Memory</span><span>{s.health.memoryMb} MB</span></li>
                <li className="flex justify-between"><span>Calls</span><span>{s.calls.activeNow} in progress · history only, no content</span></li>
                <li className="flex justify-between"><span>Subscriptions</span><span className="text-slate-500">{s.subscriptions.configured ? 'configured' : 'not configured yet'}</span></li>
              </ul>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}

type Alert = { level: string; code: string; message: string; count: number };
type Abuse = { heavyInviters: { userId: string; username: string | null; invitationsLast24h: number }[]; mostReported: { userId: string; username: string | null; reportsLast30d: number }[] };

export function Safety() {
  const alerts = useLoad(() => api<{ alerts: Alert[] }>('/alerts'), []);
  const abuse = useLoad(() => api<Abuse>('/abuse'), []);
  return (
    <>
      <Panel title="Security and safety alerts" actions={<button className="btn-ghost" onClick={alerts.reload}>Refresh</button>}>
        <ErrorNote err={alerts.err} />
        {alerts.data && alerts.data.alerts.length === 0 && <p className="text-sm text-slate-500">Nothing needs attention.</p>}
        <ul className="grid gap-2">{alerts.data?.alerts.map((a) => <li key={a.code} className="flex items-start gap-3 text-sm"><Badge value={a.level} /><span className="flex-1">{a.message}</span><strong>{a.count}</strong></li>)}</ul>
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Heavy inviters (last 24 hours)">
          <ErrorNote err={abuse.err} />
          <Table head={['User', 'Invitations']}>{abuse.data?.heavyInviters.map((x) => <tr key={x.userId}><td className="td">@{x.username ?? x.userId}</td><td className="td">{x.invitationsLast24h}</td></tr>)}</Table>
          {abuse.data?.heavyInviters.length === 0 && <p className="text-sm text-slate-500">None.</p>}
        </Panel>
        <Panel title="Most reported (last 30 days)">
          <Table head={['User', 'Reports']}>{abuse.data?.mostReported.map((x) => <tr key={x.userId}><td className="td">@{x.username ?? x.userId}</td><td className="td">{x.reportsLast30d}</td></tr>)}</Table>
          {abuse.data?.mostReported.length === 0 && <p className="text-sm text-slate-500">None.</p>}
        </Panel>
      </div>
    </>
  );
}
