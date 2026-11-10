import * as cc from '@couples/crypto';
import { validateDescriptor, type Descriptor, type MemoryType } from '@couples/media-core';
import { validateReaction, validateReplyTo, validateSticker } from '@couples/space-core';
import { api, ApiError } from './api';
import { loadDevice, saveDevice, loadRoomKeys, saveRoomKeys, type LocalDevice } from './keystore';
import type { ChatMessage, Device, Kind, SyncState, WireMessage } from './types';

type Envelope = { keyVersion: number; senderDeviceId: string; senderPublicKey: string; nonce: string; ciphertext: string };

function guessLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`;
}

// Device creation must happen exactly once per user. React StrictMode (dev) runs effects twice, and two tabs can
// start together; without this, each caller registers its own device and one secret key is lost (orphan device).
const deviceInflight = new Map<string, Promise<LocalDevice>>();
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  return locks ? ((await locks.request(name, fn)) as T) : fn();
}
function ensureDevice(userId: string): Promise<LocalDevice> {
  let p = deviceInflight.get(userId);
  if (!p) {
    p = withLock(`couples-device-${userId}`, async () => {
      const mine = await api<{ devices: Device[] }>('/devices');
      let local: LocalDevice | undefined = await loadDevice(userId);
      if (!local || !mine.devices.some((d) => d.id === local!.id && d.publicKey === local!.publicKey)) {
        const kp = cc.generateDeviceKeyPair();
        const { device } = await api<{ device: Device }>('/devices', { method: 'POST', body: { publicKey: kp.publicKey, label: guessLabel() } });
        local = { id: device.id, publicKey: kp.publicKey, secretKey: cc.toBase64(kp.secretKey) };
        await saveDevice(userId, local);
      }
      return local;
    }).finally(() => { deviceInflight.delete(userId); });
    deviceInflight.set(userId, p);
  }
  return p;
}

/**
 * All E2EE client logic for one user in one couple room.
 * Trust rules:
 *  - A device only gets room keys when an already-trusted device approves it (never automatically).
 *  - The first key is created by exactly one device (the earliest device of the member with the smallest user id) to avoid split-brain.
 *  - Rotation after a revocation only wraps the new key for devices that already held the previous key.
 */
export class E2EE {
  readonly userId: string;
  readonly coupleId: string;
  device!: LocalDevice;
  private secret!: Uint8Array;
  private keys = new Map<number, Uint8Array>();

  constructor(userId: string, coupleId: string) {
    this.userId = userId;
    this.coupleId = coupleId;
  }

  async init(): Promise<void> {
    await cc.ready();
    this.device = await ensureDevice(this.userId);
    this.secret = cc.fromBase64(this.device.secretKey);
    const saved = await loadRoomKeys(this.userId, this.coupleId);
    for (const [v, k] of Object.entries(saved as Record<string, string>)) this.keys.set(Number(v), cc.fromBase64(k));
  }

  /** Short code identifying THIS device; compare it with what the approving device shows. */
  get deviceCode(): string { return cc.safetyNumber([this.device.publicKey]); }
  get versions(): number[] { return [...this.keys.keys()].sort((a, b) => a - b); }
  hasKey(v: number): boolean { return this.keys.has(v); }
  roomCode(devices: Device[]): string { return cc.safetyNumber(devices.map((d) => d.publicKey)); }

  private async persist(): Promise<void> {
    const out: Record<string, string> = {};
    for (const [v, k] of this.keys) out[String(v)] = cc.toBase64(k);
    await saveRoomKeys(this.userId, this.coupleId, out);
  }

  /** Pull envelopes addressed to this device, open them, and report the room's key state. */
  async sync(): Promise<SyncState> {
    const envs = await api<{ keyVersion: number; envelopes: Envelope[] }>('/keys/envelopes', { query: { deviceId: this.device.id } });
    let changed = false;
    for (const e of envs.envelopes) {
      if (this.keys.has(e.keyVersion)) continue;
      try {
        this.keys.set(e.keyVersion, cc.unwrapRoomKey(e, e.senderPublicKey, this.secret));
        changed = true;
      } catch { /* envelope not for us / forged: ignore */ }
    }
    if (changed) await this.persist();
    const cd = await api<{ keyVersion: number; devices: Device[] }>('/keys/couple-devices');
    const haveCurrent = this.keys.has(cd.keyVersion);
    return { keyVersion: cd.keyVersion, devices: cd.devices, haveCurrent, pending: haveCurrent ? cd.devices.filter((d) => !d.hasKey) : [] };
  }

  private async upload(deviceId: string, items: { keyVersion: number; deviceId: string; nonce: string; ciphertext: string }[]) {
    await api('/keys/envelopes', { method: 'PUT', body: { senderDeviceId: deviceId, envelopes: items } });
  }

  /**
   * Creates key v1 if this user is the designated first user (smallest user id) and nobody holds a key yet.
   * If two of that user's devices race, the server accepts only the first upload (the other gets 403) and we back off.
   */
  async bootstrap(state: SyncState, memberIds: string[]): Promise<boolean> {
    if (state.keyVersion !== 1 || this.keys.size > 0 || state.devices.some((d) => d.hasKey)) return false;
    if (this.userId !== [...memberIds].sort()[0]) return false;
    const key = cc.generateRoomKey();
    try {
      await this.upload(this.device.id, [{ keyVersion: 1, deviceId: this.device.id, ...cc.wrapRoomKey(key, this.device.publicKey, this.secret) }]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return false; // another device won the race
      throw e;
    }
    this.keys.set(1, key);
    await this.persist();
    return true;
  }

  /** Give a pending device every room key we hold (so it can read history). Call only after the user verified the code. */
  async approve(target: Device): Promise<void> {
    const items = [...this.keys.entries()].map(([v, k]) => ({ keyVersion: v, deviceId: target.id, ...cc.wrapRoomKey(k, target.publicKey, this.secret) }));
    await this.upload(this.device.id, items);
  }

  /** Revoke one of MY devices, then rotate the room key to the devices that were already trusted. */
  async revokeAndRotate(deviceId: string): Promise<void> {
    const before = await api<{ devices: Device[] }>('/keys/couple-devices');
    const trusted = before.devices.filter((d) => d.hasKey && d.id !== deviceId);
    const r = await api<{ keyVersion: number | null }>(`/devices/${deviceId}`, { method: 'DELETE' });
    if (!r.keyVersion || this.keys.size === 0 || deviceId === this.device.id) return;
    const key = cc.generateRoomKey();
    this.keys.set(r.keyVersion, key);
    await this.persist();
    await this.upload(this.device.id, trusted.map((d) => ({ keyVersion: r.keyVersion!, deviceId: d.id, ...cc.wrapRoomKey(key, d.publicKey, this.secret) })));
  }

  // ---------- recovery ----------
  async hasBackup(): Promise<boolean> {
    try { await api('/keys/recovery'); return true; } catch (e) { if (e instanceof ApiError && e.status === 404) return false; throw e; }
  }
  private async writeBackup(recoveryKey: Uint8Array): Promise<void> {
    const roomKeys = Object.fromEntries([...this.keys].map(([v, k]) => [String(v), k]));
    await api('/keys/recovery', { method: 'PUT', body: cc.createRecoveryBlob(recoveryKey, roomKeys, this.userId) });
  }
  /** Generates a NEW recovery key, stores the encrypted backup, returns the key text to show exactly once. */
  async createRecovery(): Promise<string> {
    const rk = cc.generateRecoveryKey();
    await this.writeBackup(rk);
    return cc.formatRecoveryKey(rk);
  }
  /** Re-encrypt the backup with the SAME recovery key after new key versions arrived. */
  async refreshBackup(recoveryKeyText: string): Promise<void> {
    await this.writeBackup(cc.parseRecoveryKey(recoveryKeyText));
  }
  /** New device with no approval: restore room keys from the backup. */
  async restore(recoveryKeyText: string): Promise<void> {
    const rk = cc.parseRecoveryKey(recoveryKeyText);
    const blob = await api<{ nonce: string; ciphertext: string }>('/keys/recovery');
    const keys = cc.openRecoveryBlob(rk, blob, this.userId); // throws if the key is wrong
    for (const [v, k] of Object.entries(keys)) this.keys.set(Number(v), k);
    await this.persist();
  }

  // ---------- messages ----------
  /** Pass an existing clientMsgId to RE-encrypt the same message (editing): the ciphertext stays bound to the same message. */
  buildMessage(senderId: string, kind: Kind, keyVersion: number, payload: unknown, clientMsgId: string = crypto.randomUUID()) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptPayload(key, payload, { coupleId: this.coupleId, senderId, clientMsgId, keyVersion, kind });
    return { clientMsgId, deviceId: this.device.id, keyVersion, kind, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }

  // ---------- reactions ----------
  private reactionAad(messageId: string, userId: string, keyVersion: number) {
    return `couples-reaction-v1|${this.coupleId}|${messageId}|${userId}|${keyVersion}`;
  }
  buildReaction(messageId: string, userId: string, keyVersion: number, emoji: string) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, { emoji }, this.reactionAad(messageId, userId, keyVersion));
    return { keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  /** The emoji, or null if it cannot be opened or is not on the allow-list. */
  decryptReaction(r: { messageId: string; userId: string; keyVersion: number; nonce: string; ciphertext: string }): string | null {
    const key = this.keys.get(r.keyVersion);
    if (!key) return null;
    try { return validateReaction(cc.decryptRaw(key, r, this.reactionAad(r.messageId, r.userId, r.keyVersion))); } catch { return null; }
  }

  // ---------- calls: the setup messages (SDP, ICE) are encrypted with the room key ----------
  // The server only relays them, so it cannot swap the connection fingerprints (a man-in-the-middle attack) and cannot see network addresses.
  private callAad(callId: string, senderId: string, keyVersion: number) {
    return `couples-call-v1|${this.coupleId}|${callId}|${senderId}|${keyVersion}`;
  }
  buildCallSignal(callId: string, senderId: string, keyVersion: number, payload: unknown) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, payload, this.callAad(callId, senderId, keyVersion));
    return { callId, keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  decryptCallSignal(callId: string, senderId: string, w: { keyVersion: number; nonce: string; ciphertext: string }): unknown | null {
    const key = this.keys.get(w.keyVersion);
    if (!key) return null;
    try { return cc.decryptRaw(key, w, this.callAad(callId, senderId, w.keyVersion)); } catch { return null; }
  }

  // ---------- memories & albums ----------
  private memoryAad(createdBy: string, clientMemoryId: string, keyVersion: number, type: string) {
    return `couples-memory-v1|${this.coupleId}|${createdBy}|${clientMemoryId}|${keyVersion}|${type}`;
  }
  private albumAad(createdBy: string, clientAlbumId: string, keyVersion: number) {
    return `couples-album-v1|${this.coupleId}|${createdBy}|${clientAlbumId}|${keyVersion}`;
  }
  buildMemory(createdBy: string, type: MemoryType, keyVersion: number, payload: unknown, clientMemoryId: string = crypto.randomUUID()) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, payload, this.memoryAad(createdBy, clientMemoryId, keyVersion, type));
    return { clientMemoryId, type, keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  decryptMemory(m: { createdBy: string; clientMemoryId: string; type: string; keyVersion: number; nonce: string; ciphertext: string }):
    { state: 'ok'; payload: unknown } | { state: 'locked' } | { state: 'tampered' } {
    const key = this.keys.get(m.keyVersion);
    if (!key) return { state: 'locked' };
    try { return { state: 'ok', payload: cc.decryptRaw(key, m, this.memoryAad(m.createdBy, m.clientMemoryId, m.keyVersion, m.type)) }; }
    catch { return { state: 'tampered' }; }
  }
  buildAlbum(createdBy: string, keyVersion: number, name: string, clientAlbumId: string = crypto.randomUUID()) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, { name: name.slice(0, 60) }, this.albumAad(createdBy, clientAlbumId, keyVersion));
    return { clientAlbumId, keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  buildAlbumRename(createdBy: string, clientAlbumId: string, keyVersion: number, name: string) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, { name: name.slice(0, 60) }, this.albumAad(createdBy, clientAlbumId, keyVersion));
    return { keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  /** Returns the album name, or null if it cannot be opened (no key yet, or tampered). */
  decryptAlbumName(a: { createdBy: string; clientAlbumId: string; keyVersion: number; nonce: string; ciphertext: string }): string | null {
    const key = this.keys.get(a.keyVersion);
    if (!key) return null;
    try {
      const p = cc.decryptRaw(key, a, this.albumAad(a.createdBy, a.clientAlbumId, a.keyVersion));
      return typeof p?.name === 'string' ? p.name.slice(0, 60) : null;
    } catch { return null; }
  }

  // ---------- canvas ----------
  private canvasOpAad(canvasId: string, senderId: string, clientOpId: string, keyVersion: number) {
    return `couples-canvas-op-v1|${this.coupleId}|${canvasId}|${senderId}|${clientOpId}|${keyVersion}`;
  }
  private canvasLiveAad(canvasId: string, senderId: string, keyVersion: number) {
    return `couples-canvas-live-v1|${this.coupleId}|${canvasId}|${senderId}|${keyVersion}`;
  }
  buildCanvasOp(senderId: string, canvasId: string, keyVersion: number, payload: unknown, clientOpId: string = crypto.randomUUID()) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, payload, this.canvasOpAad(canvasId, senderId, clientOpId, keyVersion));
    return { canvasId, clientOpId, deviceId: this.device.id, keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  decryptCanvasOp(canvasId: string, w: { senderId: string; clientOpId: string; keyVersion: number; nonce: string; ciphertext: string }):
    { state: 'ok'; payload: unknown } | { state: 'locked' } | { state: 'tampered' } {
    const key = this.keys.get(w.keyVersion);
    if (!key) return { state: 'locked' };
    try { return { state: 'ok', payload: cc.decryptRaw(key, w, this.canvasOpAad(canvasId, w.senderId, w.clientOpId, w.keyVersion)) }; }
    catch { return { state: 'tampered' }; }
  }
  buildLive(senderId: string, canvasId: string, keyVersion: number, payload: unknown) {
    const key = this.keys.get(keyVersion);
    if (!key) throw new Error('NO_KEY');
    const enc = cc.encryptRaw(key, payload, this.canvasLiveAad(canvasId, senderId, keyVersion));
    return { canvasId, keyVersion, nonce: enc.nonce, ciphertext: enc.ciphertext };
  }
  decryptLive(canvasId: string, senderId: string, keyVersion: number, enc: { nonce: string; ciphertext: string }): unknown | null {
    const key = this.keys.get(keyVersion);
    if (!key) return null;
    try { return cc.decryptRaw(key, enc, this.canvasLiveAad(canvasId, senderId, keyVersion)); } catch { return null; }
  }

  decrypt(m: WireMessage): ChatMessage {
    const base = { id: m.id, clientMsgId: m.clientMsgId, senderId: m.senderId, kind: m.kind, createdAt: m.createdAt, editedAt: m.editedAt ?? null, pinned: Boolean(m.pinned) };
    if (m.deleted || !m.ciphertext || !m.nonce) return { ...base, text: null, state: 'deleted' };
    const key = this.keys.get(m.keyVersion);
    if (!key) return { ...base, text: null, state: 'locked' };
    try {
      const p = cc.decryptPayload(key, { nonce: m.nonce, ciphertext: m.ciphertext }, {
        coupleId: this.coupleId, senderId: m.senderId, clientMsgId: m.clientMsgId, keyVersion: m.keyVersion, kind: m.kind,
      });
      const media = Array.isArray(p?.media) ? (p.media as unknown[]).map(validateDescriptor).filter((d): d is Descriptor => d !== null) : [];
      const replyTo = validateReplyTo(p?.replyTo);
      const sticker = m.kind === 'sticker' ? validateSticker(p) : null; // untrusted: only allow-listed stickers
      return { ...base, text: typeof p?.text === 'string' ? p.text : null, state: 'ok', ...(media.length ? { media } : {}), ...(replyTo ? { replyTo } : {}), ...(sticker ? { sticker } : {}) };
    } catch {
      return { ...base, text: null, state: 'tampered' };
    }
  }
}
