'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Brush, Heart, Home as HomeIcon, Images, KeyRound, LogOut, MessageCircle, Monitor, Moon, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Sun } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/session';
import { useAppearance } from '@/lib/appearance';
import { E2EE } from '@/lib/e2ee';
import type { Couple, Device, SyncState, User } from '@/lib/types';
import Onboarding from './Onboarding';
import Settings from './Settings';
import Chat from './Chat';
import Home from './Home';
import LoveCanvas from './LoveCanvas';
import Memories from './Memories';
import SecurityPanel from './SecurityPanel';
import RecoveryKeyDialog from './RecoveryKeyDialog';

export default function Space() {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const [couple, setCouple] = useState<Couple | null | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const { mode, cycle } = useAppearance(couple?.theme);

  const loadCouple = useCallback(async () => {
    try { setCouple((await api<{ couple: Couple }>('/couples/me')).couple); }
    catch (e) { if (e instanceof ApiError && e.code === 'NO_COUPLE') setCouple(null); }
  }, []);

  useEffect(() => {
    if (status === 'anon') router.replace('/login');
    if (status === 'authed') loadCouple();
  }, [status, router, loadCouple]);

  // Poll: quickly while waiting for a partner to confirm, slowly otherwise (detects the partner closing the room).
  const active = couple?.status === 'active';
  useEffect(() => {
    if (status !== 'authed') return;
    const t = setInterval(loadCouple, active ? 30000 : 5000);
    return () => clearInterval(t);
  }, [status, active, loadCouple]);

  if (status !== 'authed' || !user || couple === undefined) return <main className="grid min-h-screen place-items-center text-muted">Loading…</main>;

  const header = (title: string, extra?: ReactNode) => (
    <header className="mx-auto flex h-[4.5rem] max-w-2xl items-center justify-between px-4">
      <h1 className="flex items-center gap-2 text-lg font-semibold"><Heart className="h-5 w-5 fill-accent text-accent" aria-hidden />{title}</h1>
      <div className="flex items-center gap-2">{extra}<button className="btn-ghost" aria-label={`Appearance: ${mode === 'auto' ? 'follows your device' : mode}. Tap to change.`} onClick={cycle}>{mode === 'light' ? <Sun className="h-4 w-4" /> : mode === 'dark' ? <Moon className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}</button><button className="btn-ghost" aria-label="Settings" onClick={() => setShowSettings(true)}><SettingsIcon className="h-4 w-4" /></button><button className="btn-ghost" aria-label="Log out" onClick={logout}><LogOut className="h-4 w-4" /></button></div>
    </header>
  );

  const settings = showSettings ? <Settings hasPartner={couple?.status === 'active'} onClose={() => setShowSettings(false)} /> : null;
  if (couple?.status === 'suspended') {
    return (
      <>
        {header(couple.name)}
        <main className="mx-auto max-w-md px-5 py-16 text-center">
          <h2 className="text-xl font-semibold">This room is paused</h2>
          <p className="mt-2 text-muted">Our safety team has paused this room while they look into a report. Nothing has been deleted. You can still use Settings, and this page updates by itself when the room is reopened.</p>
        </main>
        {settings}
      </>
    );
  }
  if (!couple || couple.status !== 'active') return <>{header(couple?.name ?? 'Our Space')}<Onboarding couple={couple} onChange={loadCouple} />{settings}</>;
  return <><ActiveSpace key={couple.id} user={user} couple={couple} header={header} onCoupleChanged={loadCouple} />{settings}</>;
}

type ActiveProps = { user: User; couple: Couple; header: (title: string, extra?: ReactNode) => ReactNode; onCoupleChanged: () => void };

function ActiveSpace({ user, couple, header, onCoupleChanged }: ActiveProps) {
  const ref = useRef<E2EE | null>(null);
  const syncing = useRef(false);
  const memberIds = useRef<string[]>([]);
  memberIds.current = couple.members.map((m) => m.id);

  const [state, setState] = useState<SyncState | null>(null);
  const [keyTick, setKeyTick] = useState(0);
  const [rk, setRk] = useState<string | null>(null);
  const [hasBackup, setHasBackup] = useState<boolean | null>(null);
  const [showSec, setShowSec] = useState(false);
  const [view, setView] = useState<'home' | 'chat' | 'canvas' | 'memories'>('home');
  const [unread, setUnread] = useState(0);
  const [memoriesOpened, setMemoriesOpened] = useState(false);
  const [canvasOpened, setCanvasOpened] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [restoreText, setRestoreText] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const x = ref.current;
    if (!x || syncing.current) return;
    syncing.current = true;
    try {
      let s = await x.sync();
      if (await x.bootstrap(s, memberIds.current)) { s = await x.sync(); setRk(await x.createRecovery()); setHasBackup(true); }
      setState(s);
      setKeyTick((t) => t + 1);
    } catch { setErr('Could not sync encryption keys. Retrying…'); }
    finally { syncing.current = false; }
  }, []);

  useEffect(() => {
    let alive = true;
    const x = new E2EE(user.id, couple.id);
    (async () => {
      try {
        await x.init();
        if (!alive) return;
        ref.current = x;
        await refresh();
        setHasBackup(await x.hasBackup());
      } catch { if (alive) setErr('Could not set up encryption on this device.'); }
    })();
    return () => { alive = false; ref.current = null; };
  }, [user.id, couple.id, refresh]);

  // Fallback in case a realtime event is missed: re-check devices/keys every 10s (also bootstraps the first key).
  useEffect(() => {
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const waiting = state !== null && !state.haveCurrent;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [waiting, refresh]);

  const x = ref.current;
  const anyHolder = state?.devices.some((d) => d.hasKey) ?? false;
  const leaderId = [...memberIds.current].sort()[0];
  const leaderName = couple.members.find((m) => m.id === leaderId)?.displayName ?? 'your partner';
  const waitingHint = anyHolder
    ? 'Open Our Space on a device that already works. It will show an “approve” banner (and a red shield). Check the code below matches before approving.'
    : leaderId === user.id
      ? 'Creating your first key…'
      : `${leaderName} needs to open Our Space first; that creates the room’s first key. Then they’ll see a banner to approve this device.`;
  async function guarded(fn: () => Promise<void>) {
    setErr(null); setBusy(true);
    try { await fn(); await refresh(); } catch (e) { setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  const owner = (d: Device) => (d.isMine ? 'one of your devices' : 'your partner’s device');
  const pendingCount = state?.pending.length ?? 0;

  const shield = state && x ? (
    <button className="btn-ghost relative" aria-label="Security and devices" onClick={() => setShowSec(true)}>
      {pendingCount ? <ShieldAlert className="h-4 w-4 text-accent" /> : <ShieldCheck className="h-4 w-4" />}
      {pendingCount > 0 && <span className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-accent text-[10px] text-white">{pendingCount}</span>}
    </button>
  ) : null;

  return (
    <>
      {header(couple.name, shield)}
      {err && <p role="alert" className="mx-auto mb-2 max-w-2xl rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-500">{err}</p>}

      {!state || !x ? (
        <main className="grid place-items-center py-20 text-muted">Setting up encryption on this device…</main>
      ) : waiting ? (
        <main className="mx-auto grid max-w-md gap-4 px-5 py-6">
          <section className="card grid gap-3 text-center" aria-live="polite">
            <KeyRound className="mx-auto h-8 w-8 text-accent2" aria-hidden />
            <h2 className="text-lg font-semibold">This device needs approval</h2>
            <p className="text-sm text-muted">{waitingHint}</p>
            <p className="rounded-2xl bg-bg/70 p-3 font-mono text-lg tracking-wider">{x.deviceCode}</p>
           <p className="text-xs text-muted">
  Device ID: {x.device.id.slice(0, 12)}
</p>
          </section>
          <section className="card grid gap-2">
            <h3 className="font-medium">No other device? Use your recovery key</h3>
            <label className="label" htmlFor="restore">Recovery key</label>
            <input id="restore" className="input font-mono" placeholder="XXXX-XXXX-…" value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
            <button className="btn-primary" disabled={busy || restoreText.length < 20} onClick={() => guarded(async () => { await x.restore(restoreText); setRestoreText(''); })}>Restore my keys</button>
          </section>
        </main>
      ) : (
        <>
          {state.pending.map((d) => (
            <div key={d.id} className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center justify-between gap-2 rounded-2xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm" role="alert">
              <span>New device “{d.label}” ({owner(d)}) wants to join. Code <strong className="font-mono">{x.roomCode([d])}</strong>. Approve only if it matches what that device shows.</span>
              <span className="flex gap-2">
                <button className="btn-primary" disabled={busy} onClick={() => guarded(() => x.approve(d))}>Approve</button>
                {d.isMine && <button className="btn-ghost" disabled={busy} onClick={() => guarded(() => x.revokeAndRotate(d.id))}>Remove</button>}
              </span>
            </div>
          ))}
          {hasBackup === false && (
            <div className="mx-auto mb-2 flex max-w-2xl flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-surface/70 px-4 py-3 text-sm">
              <span>Set up a recovery key so you never lose your history.</span>
              <button className="btn-ghost" disabled={busy} onClick={() => guarded(async () => { setRk(await x.createRecovery()); setHasBackup(true); })}>Create recovery key</button>
            </div>
          )}
          <nav className="mx-auto mb-2 flex max-w-2xl gap-1.5 px-3" aria-label="Sections">
            <button className={`btn-ghost relative flex-1 px-2 ${view === 'home' ? 'border-accent2 bg-accent2/20' : ''}`} aria-current={view === 'home' ? 'page' : undefined} onClick={() => { setView('home'); }}><HomeIcon className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Home</span></button>
            <button className={`btn-ghost relative flex-1 px-2 ${view === 'chat' ? 'border-accent2 bg-accent2/20' : ''}`} aria-current={view === 'chat' ? 'page' : undefined} onClick={() => { setView('chat'); }}><MessageCircle className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Chat</span>{unread > 0 && view !== 'chat' && <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-xs font-semibold text-white" aria-label={`${unread} unread messages`}>{unread > 99 ? '99+' : unread}</span>}</button>
            <button className={`btn-ghost relative flex-1 px-2 ${view === 'canvas' ? 'border-accent2 bg-accent2/20' : ''}`} aria-current={view === 'canvas' ? 'page' : undefined} onClick={() => { setView('canvas'); setCanvasOpened(true); }}><Brush className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Canvas</span></button>
            <button className={`btn-ghost relative flex-1 px-2 ${view === 'memories' ? 'border-accent2 bg-accent2/20' : ''}`} aria-current={view === 'memories' ? 'page' : undefined} onClick={() => { setView('memories'); setMemoriesOpened(true); }}><Images className="h-4 w-4" aria-hidden /><span className="max-sm:sr-only">Memories</span></button>
          </nav>
          <div className={view === 'home' ? '' : 'hidden'}>
            <Home user={user} couple={couple} e2ee={x} keyTick={keyTick} unread={unread} visible={view === 'home'} go={(v) => { setView(v); if (v === 'canvas') setCanvasOpened(true); if (v === 'memories') setMemoriesOpened(true); }} onCoupleChanged={onCoupleChanged} />
          </div>
          <div className={view === 'chat' ? '' : 'hidden'}>
            <Chat user={user} couple={couple} e2ee={x} keyTick={keyTick} keyVersion={state.keyVersion} visible={view === 'chat'} onKeysUpdated={refresh} onCoupleChanged={onCoupleChanged} onUnread={setUnread} />
          </div>
          {memoriesOpened && (
            <div className={view === 'memories' ? '' : 'hidden'}>
              <Memories user={user} e2ee={x} keyTick={keyTick} keyVersion={state.keyVersion} visible={view === 'memories'} />
            </div>
          )}
          {canvasOpened && (
            <div className={view === 'canvas' ? '' : 'hidden'}>
              <LoveCanvas user={user} e2ee={x} keyTick={keyTick} keyVersion={state.keyVersion} partnerName={couple.members.find((m) => m.id !== user.id)?.displayName ?? 'your partner'} onKeysUpdated={refresh} />
            </div>
          )}
        </>
      )}

      {showSec && state && x && <SecurityPanel e2ee={x} state={state} hasBackup={hasBackup} onClose={() => setShowSec(false)} onChanged={refresh} />}
      {rk && <RecoveryKeyDialog text={rk} onDone={() => setRk(null)} />}
    </>
  );
}
