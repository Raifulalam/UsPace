'use client';
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Mic, MicOff, Phone, PhoneOff, RefreshCw, Video, VideoOff } from 'lucide-react';
import { formatDuration } from '@couples/space-core';
import { CallManager, END_TEXT, IDLE, type CallState, type CallType } from '@/lib/calls';
import { connectSocket } from '@/lib/socket';
import type { E2EE } from '@/lib/e2ee';
import type { Couple, User } from '@/lib/types';
import { Avatar } from './Avatar';

type Controls = { start: (type: CallType) => void; busy: boolean; available: boolean };
const Ctx = createContext<Controls>({ start: () => {}, busy: false, available: false });
export const useCalls = () => useContext(Ctx);

const noopSubscribe = () => () => {};
const idle = () => IDLE;

/** Plays a MediaStream. Remote streams are never muted; the local preview always is (so you never hear yourself). */
function Stream({ stream, muted, mirror, className, label }: { stream: MediaStream | null; muted?: boolean; mirror?: boolean; className?: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={className} style={mirror ? { transform: 'scaleX(-1)' } : undefined} />;
}

/**
 * Owns the always-on connection used for calls and shows the call screens. It sits above the whole app, so an incoming call
 * rings wherever you are (Home, Chat, Canvas…). Permissions for camera and microphone are requested only when a call starts or is accepted.
 */
export default function CallProvider({ user, couple, e2ee, keyVersion, children }: { user: User; couple: Couple; e2ee: E2EE; keyVersion: number; children: ReactNode }) {
  const [mgr, setMgr] = useState<CallManager | null>(null);
  const kv = useRef(keyVersion);
  kv.current = keyVersion;

  useEffect(() => {
    const socket = connectSocket();
    socket.on('connect', () => socket.emit('couple:join', () => {})); // every (re)connect joins the room again
    const m = new CallManager({ socket, e2ee, userId: user.id, getKeyVersion: () => kv.current });
    setMgr(m);
    return () => { m.dispose(); socket.removeAllListeners(); socket.disconnect(); setMgr(null); };
  }, [e2ee, user.id]);

  const state = useSyncExternalStore(mgr?.subscribe ?? noopSubscribe, mgr?.getSnapshot ?? idle, idle);
  const partner = couple.members.find((m) => m.id !== user.id);
  const partnerName = partner?.displayName ?? partner?.username ?? 'your partner';
  const controls: Controls = {
    start: (t) => { void mgr?.start(t); },
    busy: state.phase !== 'idle' && state.phase !== 'ended',
    available: Boolean(mgr),
  };

  return (
    <Ctx.Provider value={controls}>
      {children}
      {mgr && state.phase === 'incoming' && <Incoming state={state} name={partnerName} mgr={mgr} />}
      {mgr && ['calling', 'connecting', 'connected', 'reconnecting'].includes(state.phase) && <Active state={state} name={partnerName} mgr={mgr} />}
      {mgr && state.phase === 'ended' && <Ended state={state} mgr={mgr} />}
    </Ctx.Provider>
  );
}

function Incoming({ state, name, mgr }: { state: CallState; name: string; mgr: CallManager }) {
  useEffect(() => { // best effort: phones that allow it will buzz while it rings
    const t = setInterval(() => navigator.vibrate?.([300, 150, 300]), 2000);
    return () => { clearInterval(t); navigator.vibrate?.(0); };
  }, []);
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="inc-h" className="fixed inset-x-0 top-0 z-[70] mx-auto max-w-md p-3">
      <div className="card flex items-center gap-3 border-accent2 shadow-soft">
        <Avatar name={name} size={48} />
        <div className="min-w-0 flex-1"><h2 id="inc-h" className="truncate font-semibold">{name}</h2><p className="text-sm text-muted">Incoming {state.type === 'video' ? 'video' : 'voice'} call…</p></div>
        <button className="btn bg-red-600 px-3 text-white hover:bg-red-700" aria-label={`Decline call from ${name}`} onClick={() => mgr.reject()}><PhoneOff className="h-5 w-5" /></button>
        <button className="btn bg-emerald-600 px-3 text-white hover:bg-emerald-700" aria-label={`Accept ${state.type} call from ${name}`} onClick={() => void mgr.accept()}>{state.type === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}</button>
      </div>
    </div>
  );
}

function Active({ state, name, mgr }: { state: CallState; name: string; mgr: CallManager }) {
  const video = state.type === 'video';
  const status = state.phase === 'calling' ? `Calling ${name}…` : state.phase === 'connecting' ? 'Connecting…' : state.phase === 'reconnecting' ? 'Reconnecting…' : formatDuration(state.seconds);
  const round = 'btn h-14 w-14 rounded-full p-0';
  return (
    <div role="dialog" aria-modal="true" aria-label={`Call with ${name}`} className="fixed inset-0 z-[60] flex flex-col bg-neutral-950 text-white">
      <div className="relative flex-1 overflow-hidden">
        {video && state.remoteStream ? <Stream stream={state.remoteStream} className="h-full w-full object-cover" label={`${name}'s video`} />
          : <div className="grid h-full place-items-center"><div className="grid justify-items-center gap-3"><Avatar name={name} size={112} /><p className="text-xl font-semibold">{name}</p></div></div>}
        {!video && <Stream stream={state.remoteStream} className="hidden" label={`${name}'s audio`} />}
        {video && state.localStream && <Stream stream={state.localStream} muted mirror className={`absolute right-3 top-3 h-36 w-28 rounded-2xl border border-white/30 object-cover shadow-lg ${state.cameraOff ? 'opacity-30' : ''}`} label="Your camera" />}
        <p className="absolute left-0 right-0 top-4 text-center text-sm drop-shadow" role="status" aria-live="polite">{status}</p>
        {state.phase === 'reconnecting' && <p className="absolute left-0 right-0 top-12 text-center text-xs text-amber-300">The connection is weak. Trying to reconnect…</p>}
        {state.error && <p role="alert" className="absolute bottom-3 left-0 right-0 text-center text-sm text-red-300">{state.error}</p>}
      </div>
      <div className="flex items-center justify-center gap-4 bg-black/60 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <button className={`${round} ${state.muted ? 'bg-white text-black' : 'bg-white/15 text-white'}`} aria-label={state.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={state.muted} onClick={() => mgr.toggleMute()}>{state.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}</button>
        {video && <button className={`${round} ${state.cameraOff ? 'bg-white text-black' : 'bg-white/15 text-white'}`} aria-label={state.cameraOff ? 'Turn camera on' : 'Turn camera off'} aria-pressed={state.cameraOff} onClick={() => mgr.toggleCamera()}>{state.cameraOff ? <VideoOff className="h-6 w-6" /> : <Video className="h-6 w-6" />}</button>}
        {video && state.canSwitchCamera && <button className={`${round} bg-white/15 text-white`} aria-label="Switch camera" onClick={() => void mgr.switchCamera()}><RefreshCw className="h-6 w-6" /></button>}
        <button className={`${round} bg-red-600 text-white hover:bg-red-700`} aria-label="End call" onClick={() => mgr.hangup()}><PhoneOff className="h-6 w-6" /></button>
      </div>
    </div>
  );
}

function Ended({ state, mgr }: { state: CallState; mgr: CallManager }) {
  useEffect(() => { const t = setTimeout(() => mgr.dismiss(), 6000); return () => clearTimeout(t); }, [mgr]);
  const text = state.error ?? END_TEXT[state.endReason ?? ''] ?? 'Call ended.';
  return (
    <div role="status" aria-live="polite" className="fixed inset-x-0 bottom-4 z-[70] mx-auto flex max-w-sm items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
      <span className="text-sm">{text}</span>
      <button className="btn-ghost px-3 py-1 text-sm" onClick={() => mgr.dismiss()}>OK</button>
    </div>
  );
}
