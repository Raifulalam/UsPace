'use client';
import { useEffect, useState } from 'react';
import { api, say, type Admin } from '@/lib/api';
import { can } from '@/lib/perms';
import { Badge, ErrorNote, Panel, Table, fmtDate, useLoad } from '../ui';

type Settings = {
  appName: string; logoUrl: string; theme: { accent: string; accent2: string }; maintenance: { enabled: boolean; message: string };
  limits: { invitesPerDay: number; reportsPerDay: number; freeStorageBytes: number }; features: Record<string, boolean>; legal: { termsUrl: string; privacyUrl: string; guidelinesUrl: string };
};
const GB = 1073741824;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Only the settings that actually changed are sent, so the audit log shows exactly what was edited. */
function diffPatch(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b)) {
    if (isObj(a[k]) && isObj(b[k])) { const d = diffPatch(a[k] as Record<string, unknown>, b[k] as Record<string, unknown>); if (d) out[k] = d; }
    else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k];
  }
  return Object.keys(out).length ? out : undefined;
}
const FEATURE_LABELS: Record<string, string> = { chat: 'Chat', canvas: 'Live Love Canvas', memories: 'Our Memories', media: 'Photo, video and voice uploads', games: 'Couple games', calls: 'Voice and video calls', wallpaper: 'Android live wallpaper' };

export function SettingsPanel({ admin }: { admin: Admin }) {
  const { data, err, reload } = useLoad(() => api<{ settings: Settings }>('/settings'), []);
  const [form, setForm] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setForm(structuredClone(data.settings)); }, [data]);
  if (!form || !data) return <ErrorNote err={err} />;
  const editable = can(admin.role, 'settings:write');
  const patch = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  const nested = <K extends 'theme' | 'maintenance' | 'limits' | 'legal'>(k: K, field: string, v: unknown) => setForm({ ...form, [k]: { ...form[k], [field]: v } });

  const save = async () => {
    setMsg(null); setSaveErr(null);
    const p = diffPatch(data.settings as unknown as Record<string, unknown>, form as unknown as Record<string, unknown>);
    if (!p) { setMsg('No changes to save.'); return; }
    if ((p.maintenance as { enabled?: boolean } | undefined)?.enabled === true && !confirm('Turn ON maintenance mode? Everyone using the app will see the maintenance message until you turn it off.')) return;
    setBusy(true);
    try { await api('/settings', { method: 'PATCH', body: p }); setMsg('Saved. Changes are live now and recorded in the audit log.'); await reload(); }
    catch (e) { setSaveErr(say(e)); } finally { setBusy(false); }
  };
  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1 text-sm"><span className="text-slate-600">{label}</span>{children}</label>;
  const dis = !editable;

  return (
    <>
      {!editable && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Your role can view settings but not change them.</p>}
      <Panel title="General">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="App name"><input className="field" disabled={dis} maxLength={40} value={form.appName} onChange={(e) => patch('appName', e.target.value)} /></Field>
          <Field label="Logo URL (https)"><input className="field" disabled={dis} value={form.logoUrl} onChange={(e) => patch('logoUrl', e.target.value)} placeholder="https://…" /></Field>
          <Field label="Accent colour"><input type="color" className="h-10 w-full rounded-lg border border-slate-300" disabled={dis} value={form.theme.accent} onChange={(e) => nested('theme', 'accent', e.target.value)} /></Field>
          <Field label="Second accent colour"><input type="color" className="h-10 w-full rounded-lg border border-slate-300" disabled={dis} value={form.theme.accent2} onChange={(e) => nested('theme', 'accent2', e.target.value)} /></Field>
        </div>
      </Panel>
      <Panel title="Maintenance mode">
        <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={dis} checked={form.maintenance.enabled} onChange={(e) => nested('maintenance', 'enabled', e.target.checked)} />Maintenance mode is on (the app shows the message below; this dashboard stays available)</label>
        <Field label="Message shown to users"><input className="field" disabled={dis} maxLength={300} value={form.maintenance.message} onChange={(e) => nested('maintenance', 'message', e.target.value)} /></Field>
      </Panel>
      <Panel title="Limits">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Invitations per person per day"><input type="number" min={1} max={100} className="field" disabled={dis} value={form.limits.invitesPerDay} onChange={(e) => nested('limits', 'invitesPerDay', Number(e.target.value))} /></Field>
          <Field label="Reports per person per day"><input type="number" min={1} max={50} className="field" disabled={dis} value={form.limits.reportsPerDay} onChange={(e) => nested('limits', 'reportsPerDay', Number(e.target.value))} /></Field>
          <Field label="Free storage per couple (GB)"><input type="number" min={0.1} step={0.1} className="field" disabled={dis} value={+(form.limits.freeStorageBytes / GB).toFixed(2)} onChange={(e) => nested('limits', 'freeStorageBytes', Math.round(Number(e.target.value) * GB))} /></Field>
        </div>
      </Panel>
      <Panel title="Feature switches">
        <div className="grid gap-2 md:grid-cols-2">
          {Object.entries(form.features).map(([k, on]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={dis} checked={on} onChange={(e) => patch('features', { ...form.features, [k]: e.target.checked })} />{FEATURE_LABELS[k] ?? k}</label>)}
        </div>
        <p className="mt-2 text-xs text-slate-500">Chat, canvas, memories and uploads switch off immediately. Games, calls and the wallpaper switches are ready for when those features ship.</p>
      </Panel>
      <Panel title="Legal pages (https links)">
        <div className="grid gap-3 md:grid-cols-3">
          {(['termsUrl', 'privacyUrl', 'guidelinesUrl'] as const).map((k) => <Field key={k} label={{ termsUrl: 'Terms of service', privacyUrl: 'Privacy policy', guidelinesUrl: 'Community guidelines' }[k]}><input className="field" disabled={dis} value={form.legal[k]} onChange={(e) => nested('legal', k, e.target.value)} placeholder="https://…" /></Field>)}
        </div>
      </Panel>
      <ErrorNote err={saveErr} />
      {msg && <p role="status" className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}
      {editable && <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>}
    </>
  );
}

type AdminRow = Admin & { lastLoginAt: string | null; createdAt: string };
export function AdminsPanel({ admin }: { admin: Admin }) {
  const { data, err, reload } = useLoad(() => api<{ admins: AdminRow[] }>('/admins'), []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'moderator' | 'support' | 'superadmin'>('moderator');
  const [invite, setInvite] = useState<{ email: string; url: string } | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setActionErr(null); try { await fn(); await reload(); } catch (e) { setActionErr(say(e)); } };
  return (
    <>
      <Panel title="Invite an admin">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ admin: Admin; setupUrl: string }>('/admins', { method: 'POST', body: { email, role } }); setInvite({ email: r.admin.email, url: r.setupUrl }); setEmail(''); }); }}>
          <label className="sr-only" htmlFor="ie">Email</label><input id="ie" type="email" required className="field max-w-xs" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label className="sr-only" htmlFor="ir">Role</label>
          <select id="ir" className="field w-auto" value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="moderator">Moderator</option><option value="support">Support (read-only)</option><option value="superadmin">Superadmin</option></select>
          <button className="btn-primary">Create invitation</button>
        </form>
        {invite && (
          <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
            <p>Send this one-time link to <strong>{invite.email}</strong> through a secure channel. It expires in 48 hours and is shown only now:</p>
            <p className="mt-2 break-all rounded bg-white p-2 font-mono text-xs">{invite.url}</p>
            <button className="btn-ghost mt-2" onClick={() => navigator.clipboard.writeText(invite.url).catch(() => {})}>Copy link</button>
          </div>
        )}
      </Panel>
      <Panel title="Admin accounts">
        <ErrorNote err={err ?? actionErr} />
        <Table head={['Email', 'Role', 'Status', 'Authenticator', 'Last sign-in', '']}>
          {data?.admins.map((a) => {
            const me = a.id === admin.id;
            return (
              <tr key={a.id}>
                <td className="td">{a.email}{me && <span className="ml-1 text-xs text-slate-500">(you)</span>}</td>
                <td className="td"><label className="sr-only" htmlFor={`r-${a.id}`}>Role for {a.email}</label>
                  <select id={`r-${a.id}`} className="field w-auto py-1" disabled={me} value={a.role} onChange={(e) => { if (confirm(`Change ${a.email} to ${e.target.value}? They will be signed out.`)) void run(() => api(`/admins/${a.id}/role`, { method: 'POST', body: { role: e.target.value } })); }}>
                    <option value="superadmin">superadmin</option><option value="moderator">moderator</option><option value="support">support</option>
                  </select></td>
                <td className="td"><Badge value={a.status} /></td><td className="td">{a.mfaEnabled ? 'registered' : 'not yet'}</td><td className="td">{fmtDate(a.lastLoginAt)}</td>
                <td className="td whitespace-nowrap">{!me && (<>
                  {a.status === 'active' && <button className="btn-ghost mr-1 px-2 py-1" onClick={() => { if (confirm(`Disable ${a.email}? They are signed out immediately.`)) void run(() => api(`/admins/${a.id}/disable`, { method: 'POST', body: {} })); }}>Disable</button>}
                  {a.status === 'disabled' && <button className="btn-ghost mr-1 px-2 py-1" onClick={() => void run(() => api(`/admins/${a.id}/enable`, { method: 'POST', body: {} }))}>Enable</button>}
                  {a.mfaEnabled && <button className="btn-ghost px-2 py-1" onClick={() => { if (confirm(`Reset the authenticator for ${a.email}? They must register a new one at next sign-in.`)) void run(() => api(`/admins/${a.id}/reset-mfa`, { method: 'POST', body: {} })); }}>Reset authenticator</button>}
                </>)}</td>
              </tr>
            );
          })}
        </Table>
      </Panel>
    </>
  );
}
