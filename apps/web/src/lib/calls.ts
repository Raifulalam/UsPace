import type { Socket } from 'socket.io-client';
import { validateCallSignal } from '@couples/space-core';
import { api } from './api';
import type { E2EE } from './e2ee';

export type CallType = 'audio' | 'video';
export type CallPhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type CallState = {
  phase: CallPhase; type: CallType; callId: string | null; direction: 'outgoing' | 'incoming' | null; fromUserId: string | null;
  muted: boolean; cameraOff: boolean; canSwitchCamera: boolean; seconds: number;
  localStream: MediaStream | null; remoteStream: MediaStream | null; error: string | null; endReason: string | null;
};
export const IDLE: CallState = {
  phase: 'idle', type: 'audio', callId: null, direction: null, fromUserId: null, muted: false, cameraOff: false, canSwitchCamera: false, seconds: 0,
  localStream: null, remoteStream: null, error: null, endReason: null,
};
export const END_TEXT: Record<string, string> = {
  rejected: 'Call declined.', 'no-answer': 'No answer.', hangup: 'Call ended.', canceled: 'Call canceled.', 'connection-lost': 'The connection was lost.',
  offline: 'Your partner isn’t online right now. They’ll see a missed call.', failed: 'The call couldn’t connect. Check your connection and try again.',
};
const ERR_TEXT: Record<string, string> = {
  BUSY: 'A call is already in progress.', FEATURE_DISABLED: 'Calls are switched off right now.', NO_ACTIVE_COUPLE: 'Your room isn’t active.',
  RATE_LIMITED: 'Please wait a moment before calling again.',
};

type Deps = { socket: Socket; e2ee: E2EE; userId: string; getKeyVersion: () => number };
type Ack = { ok: boolean; error?: string; state?: string } | null;

/**
 * One-to-one WebRTC call between the two partners. Audio and video go straight between the phones (encrypted by WebRTC itself,
 * or through a TURN relay that only sees ciphertext). The server only rings, relays encrypted setup messages, and keeps history.
 * The microphone and camera are requested only when someone starts or accepts a call.
 */
export class CallManager {
  private state: CallState = { ...IDLE };
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt = 0;
  private restarts = 0;
  private facing: 'user' | 'environment' = 'user';
  private wake: { release: () => Promise<void> } | null = null;
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
    deps.socket.on('call:incoming', this.onIncoming);
    deps.socket.on('call:answered', this.onAnswered);
    deps.socket.on('call:ended', this.onEnded);
    deps.socket.on('call:signal', this.onSignal);
  }

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<CallState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((f) => f()); }

  private emitAck(event: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 8000);
      this.deps.socket.emit(event, payload, (r: Ack) => { clearTimeout(t); resolve(r); });
    });
  }
  private send(payload: unknown) {
    const { callId } = this.state;
    if (!callId) return;
    try { this.deps.socket.emit('call:signal', this.deps.e2ee.buildCallSignal(callId, this.deps.userId, this.deps.getKeyVersion(), payload), () => {}); } catch { /* no room key yet */ }
  }
  private busy() { return this.state.phase !== 'idle' && this.state.phase !== 'ended'; }

  // ---------- starting and answering ----------
  async start(type: CallType) {
    if (this.busy()) return;
    this.reset();
    const callId = crypto.randomUUID();
    this.set({ phase: 'calling', type, callId, direction: 'outgoing' });
    if (!(await this.media(type))) return;
    const ack = await this.emitAck('call:start', { callId, type });
    if (!ack?.ok) { this.fail(ERR_TEXT[ack?.error ?? ''] ?? 'Could not start the call.'); return; }
    if (ack.state === 'offline') { this.finish('offline'); return; }
    this.lockScreen();
  }

  async accept() {
    const { phase, callId, type } = this.state;
    if (phase !== 'incoming' || !callId) return;
    this.set({ phase: 'connecting' });
    if (!(await this.media(type))) { this.deps.socket.emit('call:reject', { callId }, () => {}); return; }
    try { await this.createPc(); } catch { this.deps.socket.emit('call:reject', { callId }, () => {}); this.fail('Could not set up the call.'); return; }
    const ack = await this.emitAck('call:answer', { callId });
    if (!ack?.ok) { this.fail(ack?.error === 'CALL_NOT_RINGING' ? 'The call ended before you answered.' : 'Could not answer the call.'); return; }
    this.lockScreen();
  }

  reject() {
    const { phase, callId } = this.state;
    if (phase !== 'incoming' || !callId) return;
    this.deps.socket.emit('call:reject', { callId }, () => {});
    this.reset();
  }

  hangup() {
    const { phase, callId } = this.state;
    if (phase === 'incoming') return this.reject();
    if (!callId || !this.busy()) return;
    this.deps.socket.emit('call:end', { callId }, () => {});
    this.finish(phase === 'calling' ? 'canceled' : 'hangup');
  }

  dismiss() { if (this.state.phase === 'ended') this.reset(); }
  dispose() {
    this.cleanup();
    const s = this.deps.socket;
    s.off('call:incoming', this.onIncoming); s.off('call:answered', this.onAnswered); s.off('call:ended', this.onEnded); s.off('call:signal', this.onSignal);
    this.listeners.clear();
  }

  // ---------- controls ----------
  toggleMute() {
    const tracks = this.state.localStream?.getAudioTracks() ?? [];
    if (!tracks.length) return;
    const muted = !this.state.muted;
    tracks.forEach((t) => { t.enabled = !muted; });
    this.set({ muted });
  }
  toggleCamera() {
    const tracks = this.state.localStream?.getVideoTracks() ?? [];
    if (!tracks.length) return;
    const cameraOff = !this.state.cameraOff;
    tracks.forEach((t) => { t.enabled = !cameraOff; });
    this.set({ cameraOff });
  }
  async switchCamera() {
    const local = this.state.localStream;
    if (!this.pc || !local) return;
    const next = this.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } });
      const track = s.getVideoTracks()[0];
      await this.pc.getSenders().find((x) => x.track?.kind === 'video')?.replaceTrack(track);
      const old = local.getVideoTracks()[0];
      if (old) { local.removeTrack(old); old.stop(); }
      track.enabled = !this.state.cameraOff;
      local.addTrack(track);
      this.facing = next;
      this.set({ localStream: local });
    } catch { this.set({ error: 'Could not switch cameras.' }); }
  }

  // ---------- socket events ----------
  private onIncoming = (m: { callId: string; type: CallType; from: string }) => {
    if (this.busy()) { this.deps.socket.emit('call:reject', { callId: m.callId }, () => {}); return; } // already in a call
    this.reset();
    this.set({ phase: 'incoming', type: m.type, callId: m.callId, direction: 'incoming', fromUserId: m.from });
  };
  private onAnswered = (m: { callId: string }) => {
    if (m.callId !== this.state.callId) return;
    if (this.state.phase === 'calling') { this.set({ phase: 'connecting' }); void this.startCaller(); }
    else if (this.state.phase === 'incoming') this.reset(); // answered on another of your devices
  };
  private onEnded = (m: { callId: string; reason: string }) => {
    if (m.callId === this.state.callId && this.busy()) this.finish(m.reason);
  };
  private onSignal = async (m: { callId: string; from: string; keyVersion: number; nonce: string; ciphertext: string }) => {
    if (m.callId !== this.state.callId || m.from === this.deps.userId || !this.pc) return;
    const payload = validateCallSignal(this.deps.e2ee.decryptCallSignal(m.callId, m.from, m)); // decrypted but still untrusted
    if (!payload) return;
    const pc = this.pc;
    try {
      if (payload.t === 'ice') {
        if (this.remoteSet) await pc.addIceCandidate(payload.candidate); else this.pendingIce.push(payload.candidate);
      } else if (payload.t === 'offer' && this.state.direction === 'incoming') {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        await this.drainIce();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ t: 'answer', sdp: answer.sdp ?? '' });
      } else if (payload.t === 'answer' && this.state.direction === 'outgoing') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        await this.drainIce();
      }
    } catch { /* a bad message from the other side must never crash the call */ }
  };

  // ---------- connection ----------
  private async createPc() {
    const { iceServers } = await api<{ iceServers: RTCIceServer[] }>('/calls/ice');
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc; this.remoteSet = false; this.pendingIce = [];
    const remote = new MediaStream();
    pc.ontrack = (e) => { remote.addTrack(e.track); this.set({ remoteStream: remote }); };
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ t: 'ice', candidate: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => this.onConnection(pc.connectionState);
    const local = this.state.localStream;
    local?.getTracks().forEach((t) => pc.addTrack(t, local));
  }
  private async drainIce() {
    this.remoteSet = true;
    for (const c of this.pendingIce.splice(0)) await this.pc?.addIceCandidate(c).catch(() => {});
  }
  private async startCaller() {
    try {
      await this.createPc();
      const offer = await this.pc!.createOffer();
      await this.pc!.setLocalDescription(offer);
      this.send({ t: 'offer', sdp: offer.sdp ?? '' });
    } catch { this.endWithError(); }
  }
  private endWithError() {
    const { callId } = this.state;
    if (callId) this.deps.socket.emit('call:end', { callId }, () => {});
    this.finish('failed');
  }

  private onConnection(s: RTCPeerConnectionState) {
    if (s === 'connected') {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      if (this.failTimer) clearTimeout(this.failTimer);
      this.restartTimer = this.failTimer = null;
      this.restarts = 0;
      if (this.state.phase !== 'connected') {
        this.connectedAt = Date.now();
        this.set({ phase: 'connected', seconds: 0 });
        this.ticker = setInterval(() => this.set({ seconds: Math.floor((Date.now() - this.connectedAt) / 1000) }), 1000);
      }
    } else if (s === 'disconnected' || s === 'failed') {
      if (this.state.phase === 'connected') this.set({ phase: 'reconnecting' });
      // The caller tries to repair the connection (ICE restart); everyone gives up after 20 seconds.
      if (!this.restartTimer && this.state.direction === 'outgoing') this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.restartIce(); }, s === 'failed' ? 0 : 4000);
      if (!this.failTimer) this.failTimer = setTimeout(() => { this.failTimer = null; this.endWithError(); }, 20000);
    }
  }
  private async restartIce() {
    const pc = this.pc;
    if (!pc || this.restarts >= 2) return;
    this.restarts += 1;
    try {
      pc.restartIce?.();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.send({ t: 'offer', sdp: offer.sdp ?? '' });
    } catch { /* the 20-second timer ends the call if this does not work */ }
  }

  // ---------- media, cleanup ----------
  private async media(type: CallType): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) { this.fail('Calls aren’t supported in this browser.'); return false; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: type === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      this.set({ localStream: s, muted: false, cameraOff: false });
      if (type === 'video') navigator.mediaDevices.enumerateDevices().then((d) => this.set({ canSwitchCamera: d.filter((x) => x.kind === 'videoinput').length > 1 })).catch(() => {});
      return true;
    } catch (e) {
      const name = (e as DOMException)?.name;
      this.fail(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone or camera access was denied. You can allow it in your browser’s site settings, or try a voice-only call.'
        : name === 'NotFoundError' ? 'No microphone or camera was found.' : 'Could not access your microphone or camera.');
      return false;
    }
  }
  private lockScreen() {
    (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen').then((l) => { this.wake = l; }).catch(() => {});
  }
  private cleanup() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.failTimer) clearTimeout(this.failTimer);
    this.ticker = this.restartTimer = this.failTimer = null;
    this.state.localStream?.getTracks().forEach((t) => t.stop());
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.close(); this.pc = null; }
    this.wake?.release().catch(() => {}); this.wake = null;
    this.pendingIce = []; this.remoteSet = false; this.restarts = 0; this.facing = 'user';
  }
  private finish(reason: string) { this.cleanup(); this.set({ phase: 'ended', endReason: reason, localStream: null, remoteStream: null, error: null }); }
  private fail(message: string) { this.cleanup(); this.set({ phase: 'ended', error: message, endReason: null, localStream: null, remoteStream: null }); }
  private reset() { this.cleanup(); this.state = { ...IDLE }; this.listeners.forEach((f) => f()); }
}
