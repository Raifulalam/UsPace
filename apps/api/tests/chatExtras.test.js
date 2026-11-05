const crypto = require('crypto');
const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const Message = require('../src/models/Message');
const MessageReaction = require('../src/models/MessageReaction');
const { startDb, stopDb, registerUser, authed, makeCouple } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

const rnd = (n) => crypto.randomBytes(n).toString('base64');
const oid = (id) => new mongoose.Types.ObjectId(id);
const addDevice = async (U) => (await U.post('/api/v1/devices', { publicKey: rnd(32), label: 'dev' })).body.data.device.id;
const msg = (deviceId, over = {}) => ({ clientMsgId: crypto.randomUUID(), deviceId, keyVersion: 1, kind: 'text', nonce: rnd(24), ciphertext: rnd(64), ...over });
const enc = (over = {}) => ({ keyVersion: 1, nonce: rnd(24), ciphertext: rnd(64), ...over });
const send = async (U, device, over) => (await U.post('/api/v1/messages', msg(device, over))).body.data.message;
async function setup() {
  const c = await makeCouple(app);
  c.da = await addDevice(c.A);
  c.db = await addDevice(c.B);
  return c;
}

describe('reactions', () => {
  test('one per person, replaceable, delivered with the message list, removable', async () => {
    const { A, B, da } = await setup();
    const m = await send(A, da);
    const url = `/api/v1/messages/${m.id}/reaction`;
    const first = await B.put(url, enc());
    expect(first.status).toBe(200);
    const second = await B.put(url, enc());
    expect(second.body.data.reaction.ciphertext).not.toBe(first.body.data.reaction.ciphertext); // replaced, not added
    expect((await A.put(url, enc())).status).toBe(200);
    const list = await A.get('/api/v1/messages');
    expect(list.body.data.reactions).toHaveLength(2);
    expect(Object.keys(list.body.data.reactions[0]).sort()).toEqual(['ciphertext', 'keyVersion', 'messageId', 'nonce', 'userId']);
    expect((await B.del(url)).status).toBe(204);
    expect((await A.get('/api/v1/messages')).body.data.reactions).toHaveLength(1);
  });

  test('rejects stale keys, oversize payloads and other rooms; deleting the message removes its reactions', async () => {
    const { A, B, da } = await setup();
    const other = await setup();
    const m = await send(A, da);
    const url = `/api/v1/messages/${m.id}/reaction`;
    expect((await B.put(url, enc({ keyVersion: 9 }))).status).toBe(409);
    expect((await B.put(url, enc({ ciphertext: rnd(3000) }))).status).toBe(400);
    expect((await B.put(url, { ...enc(), emoji: '❤️' })).status).toBe(400); // plaintext emoji is refused
    expect((await other.A.put(url, enc())).status).toBe(404);
    await B.put(url, enc());
    await A.del(`/api/v1/messages/${m.id}`);
    expect(await MessageReaction.countDocuments({ messageId: oid(m.id) })).toBe(0);
    expect((await B.put(url, enc())).status).toBe(404); // cannot react to a deleted message
  });
});

describe('editing', () => {
  test('only the sender, only text/media, only for 24 hours, only with the current key', async () => {
    const { A, B, da } = await setup();
    const m = await send(A, da);
    const url = `/api/v1/messages/${m.id}`;
    expect((await B.patch(url, enc())).status).toBe(404);
    expect((await A.patch(url, enc({ keyVersion: 9 }))).status).toBe(409);
    const ok = await A.patch(url, enc());
    expect(ok.status).toBe(200);
    expect(ok.body.data.message.editedAt).toBeTruthy();
    expect(ok.body.data.message.ciphertext).not.toBe(m.ciphertext);
    const heart = await send(A, da, { kind: 'heart' });
    expect((await A.patch(`/api/v1/messages/${heart.id}`, enc())).status).toBe(409);
    await Message.collection.updateOne({ _id: oid(m.id) }, { $set: { createdAt: new Date(Date.now() - 25 * 3600 * 1000) } });
    const late = await A.patch(url, enc());
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('EDIT_WINDOW_CLOSED');
    await A.del(url);
    expect((await A.patch(url, enc())).status).toBe(404);
  });
});

describe('pinning', () => {
  test('either partner can pin; five at most; deleted messages drop out', async () => {
    const { A, B, da } = await setup();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await send(A, da)).id);
    for (let i = 0; i < 5; i++) expect((await B.put(`/api/v1/messages/${ids[i]}/pin`)).body.data.message.pinned).toBe(true);
    expect((await B.put(`/api/v1/messages/${ids[0]}/pin`)).status).toBe(200); // pinning an already pinned message is fine
    const over = await A.put(`/api/v1/messages/${ids[5]}/pin`);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOO_MANY_PINNED');
    expect((await A.get('/api/v1/messages/pinned')).body.data.messages).toHaveLength(5);
    expect((await A.del(`/api/v1/messages/${ids[0]}/pin`)).body.data.message.pinned).toBe(false);
    expect((await A.put(`/api/v1/messages/${ids[5]}/pin`)).status).toBe(200);
    await A.del(`/api/v1/messages/${ids[1]}`);
    expect((await B.get('/api/v1/messages/pinned')).body.data.messages.map((x) => x.id)).not.toContain(ids[1]);
    const outsider = authed(app, await registerUser(app));
    expect((await outsider.get('/api/v1/messages/pinned')).status).toBe(404);
  });
});

describe('read state', () => {
  test('unread counts, forward-only reading, and reciprocal "seen"', async () => {
    const { A, B, a, b, da, db } = await setup();
    const m1 = await send(A, da), m2 = await send(A, da), m3 = await send(A, da);
    expect((await B.get('/api/v1/messages/read-state')).body.data.unread).toBe(3);
    expect((await A.get('/api/v1/messages/read-state')).body.data.unread).toBe(0); // your own messages are never unread
    expect((await B.put('/api/v1/messages/read', { upTo: m2.id })).body.data.lastReadId).toBe(m2.id);
    expect((await B.get('/api/v1/messages/read-state')).body.data.unread).toBe(1);
    expect((await B.put('/api/v1/messages/read', { upTo: m1.id })).body.data.lastReadId).toBe(m2.id); // never moves backwards
    expect((await A.get('/api/v1/messages/read-state')).body.data).toMatchObject({ partner: m2.id, receiptsEnabled: true });
    await send(B, db);
    expect((await B.get('/api/v1/messages/read-state')).body.data.unread).toBe(1);

    expect((await B.patch('/api/v1/users/me', { readReceipts: false })).body.data.user.readReceipts).toBe(false);
    expect((await A.get('/api/v1/messages/read-state')).body.data).toMatchObject({ partner: null, receiptsEnabled: false });
    expect((await B.put('/api/v1/messages/read', { upTo: m3.id })).status).toBe(200); // still tracked for B's own unread count
    expect((await B.get('/api/v1/messages/read-state')).body.data.unread).toBe(0);
    expect((await B.get('/api/v1/messages/read-state')).body.data.partner).toBe(null);
    await B.patch('/api/v1/users/me', { readReceipts: true });
    expect((await A.get('/api/v1/messages/read-state')).body.data.partner).toBe(m3.id);

    const other = await setup();
    const foreign = await send(other.A, other.da);
    expect((await B.put('/api/v1/messages/read', { upTo: foreign.id })).status).toBe(404);
    expect(a.user.id).toBeTruthy(); expect(b.user.id).toBeTruthy();
  });
});

describe('room-wide disappearing messages', () => {
  const secondsLeft = (m) => Math.round((new Date(m.expiresAt).getTime() - Date.now()) / 1000);

  test('the timer is validated, enforced by the server, and cannot be exceeded by a client', async () => {
    const { A, B, da, db } = await setup();
    expect((await A.patch('/api/v1/couples/me', { messageTtlSec: 5 })).status).toBe(400);
    expect((await send(A, da)).expiresAt).toBeNull();

    expect((await B.patch('/api/v1/couples/me', { messageTtlSec: 3600 })).body.data.couple.messageTtlSec).toBe(3600);
    const defaulted = await send(A, da);
    expect(secondsLeft(defaulted)).toBeGreaterThan(3500);
    expect(secondsLeft(defaulted)).toBeLessThanOrEqual(3600);
    expect(secondsLeft(await send(B, db, { expiresInSec: 7200 }))).toBeLessThanOrEqual(3600); // a longer lifetime is clamped
    expect(secondsLeft(await send(A, da, { expiresInSec: 60 }))).toBeLessThanOrEqual(60); // a shorter one is allowed

    expect((await A.patch('/api/v1/couples/me', { messageTtlSec: 0 })).body.data.couple.messageTtlSec).toBe(0);
    expect((await send(A, da)).expiresAt).toBeNull();
  });
});

describe('profile settings', () => {
  test('display name and read receipts', async () => {
    const U = authed(app, await registerUser(app));
    const r = await U.patch('/api/v1/users/me', { displayName: '  Sam Rivers  ' });
    expect(r.body.data.user.displayName).toBe('Sam Rivers');
    expect((await U.get('/api/v1/auth/me')).body.data.user.readReceipts).toBe(true);
    expect((await U.patch('/api/v1/users/me', {})).status).toBe(400);
    expect((await U.patch('/api/v1/users/me', { role: 'superadmin' })).status).toBe(400);
    expect((await U.patch('/api/v1/users/me', { displayName: '' })).status).toBe(400);
    expect((await U.patch('/api/v1/users/me', { displayName: 'x'.repeat(51) })).status).toBe(400);
  });
});
