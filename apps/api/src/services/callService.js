const config = require('../config/env');
const CallHistory = require('../models/CallHistory');
const AppError = require('../utils/AppError');
const rules = require('../calls/rules');
const realtime = require('./realtime');
const { requireActiveCouple } = require('./access');

// This service only controls WHO may ring, answer and end a call, and relays encrypted setup messages.
// The audio and video themselves travel directly between the two phones (WebRTC, encrypted); they never touch this server,
// and recording is not implemented anywhere.
const timers = new Map();
const now = () => new Date();
const both = (call, event, payload) => { realtime.emitToUser(String(call.callerId), event, payload); realtime.emitToUser(String(call.calleeId), event, payload); };

const view = (c, meId) => ({
  id: c.callId, direction: String(c.callerId) === String(meId) ? 'outgoing' : 'incoming', withUserId: String(c.callerId) === String(meId) ? String(c.calleeId) : String(c.callerId),
  type: c.type, status: c.status, startedAt: c.startedAt, durationSec: c.durationSec || 0, reason: c.endedReason || null,
});

/** Atomically moves a call to a new state; returns the updated call, or null if it was not in an allowed state. */
async function transition(callId, from, to, fields = {}) {
  const allowed = from.filter((f) => rules.canTransition(f, to));
  if (allowed.length === 0) return null;
  const call = await CallHistory.findOneAndUpdate(
    { callId, status: { $in: allowed } },
    { $set: { status: to, active: rules.isActive(to), ...(rules.isActive(to) ? {} : { endedAt: now() }), ...fields } },
    { new: true }
  );
  if (call && !rules.isActive(to)) { clearTimeout(timers.get(callId)); timers.delete(callId); }
  return call;
}

async function cleanupCouple(coupleId, at = Date.now()) {
  await CallHistory.updateMany({ coupleId, active: true, status: 'ringing', startedAt: { $lt: new Date(at - rules.STALE_RINGING_MS) } },
    { $set: { status: 'missed', active: false, endedAt: now(), endedReason: 'stale' } });
  await CallHistory.updateMany({ coupleId, active: true, status: 'answered', startedAt: { $lt: new Date(at - rules.STALE_ANSWERED_MS) } },
    { $set: { status: 'failed', active: false, endedAt: now(), endedReason: 'stale' } });
}
/** Housekeeping for calls whose end event was lost (e.g. the server restarted mid-call). */
async function sweepStale(at = Date.now()) {
  const ringing = await CallHistory.updateMany({ active: true, status: 'ringing', startedAt: { $lt: new Date(at - rules.STALE_RINGING_MS) } },
    { $set: { status: 'missed', active: false, endedAt: now(), endedReason: 'stale' } });
  const answered = await CallHistory.updateMany({ active: true, status: 'answered', startedAt: { $lt: new Date(at - rules.STALE_ANSWERED_MS) } },
    { $set: { status: 'failed', active: false, endedAt: now(), endedReason: 'stale' } });
  return { ringing: ringing.modifiedCount, answered: answered.modifiedCount };
}

async function startCall(user, { callId, type }) {
  const couple = await requireActiveCouple(user);
  const partnerId = couple.members.find((m) => !m.equals(user._id));
  if (!partnerId) throw new AppError(404, 'NO_PARTNER', 'You do not have a partner to call');
  await cleanupCouple(couple._id);
  const base = { coupleId: couple._id, callId, callerId: user._id, calleeId: partnerId, type, startedAt: now() };
  if (!realtime.isOnline(String(partnerId))) { // nobody to ring: record a missed call so they see it later
    await CallHistory.create({ ...base, status: 'missed', active: false, endedAt: now(), endedReason: 'offline' });
    return { state: 'offline', calleeId: String(partnerId) };
  }
  try {
    await CallHistory.create({ ...base, status: 'ringing', active: true });
  } catch (e) {
    if (e.code === 11000) throw (await CallHistory.exists({ callId })) ? new AppError(409, 'DUPLICATE_CALL', 'That call id was already used') : new AppError(409, 'BUSY', 'A call is already in progress');
    throw e;
  }
  realtime.emitToUser(String(partnerId), 'call:incoming', { callId, type, from: String(user._id) });
  timers.set(callId, setTimeout(() => { expire(callId).catch(() => {}); }, rules.RING_TIMEOUT_MS));
  timers.get(callId).unref?.();
  return { state: 'ringing', calleeId: String(partnerId) };
}

async function expire(callId) {
  const call = await transition(callId, ['ringing'], 'missed', { endedReason: 'no-answer' });
  if (call) both(call, 'call:ended', { callId, reason: 'no-answer' });
}

async function answerCall(user, callId) {
  const call = await CallHistory.findOneAndUpdate({ callId, calleeId: user._id, status: 'ringing' }, { $set: { status: 'answered', answeredAt: now() } }, { new: true });
  if (!call) throw new AppError(404, 'CALL_NOT_RINGING', 'This call is no longer ringing');
  clearTimeout(timers.get(callId)); timers.delete(callId);
  both(call, 'call:answered', { callId }); // the callee's other devices use this to stop ringing
  return view(call, user._id);
}

async function rejectCall(user, callId) {
  const call = await CallHistory.findOne({ callId, calleeId: user._id });
  const done = call && (await transition(callId, ['ringing'], 'rejected', { endedReason: 'rejected' }));
  if (!done) throw new AppError(404, 'CALL_NOT_RINGING', 'This call is no longer ringing');
  both(done, 'call:ended', { callId, reason: 'rejected' });
}

async function endCall(user, callId) {
  const call = await CallHistory.findOne({ callId, $or: [{ callerId: user._id }, { calleeId: user._id }] });
  if (!call || !call.active) throw new AppError(404, 'CALL_NOT_ACTIVE', 'This call has already ended');
  const isCaller = String(call.callerId) === String(user._id);
  let done, reason;
  if (call.status === 'ringing') {
    reason = isCaller ? 'canceled' : 'rejected';
    done = await transition(callId, ['ringing'], reason, { endedReason: reason });
  } else {
    reason = 'hangup';
    done = await transition(callId, ['answered'], 'ended', { endedReason: reason, durationSec: rules.durationSec(call.answeredAt, new Date()) });
  }
  if (!done) throw new AppError(404, 'CALL_NOT_ACTIVE', 'This call has already ended');
  both(done, 'call:ended', { callId, reason, by: String(user._id) });
}

/** Relays one encrypted setup message to the other person. The server cannot read or alter it. */
async function relaySignal(user, { callId, keyVersion, nonce, ciphertext }) {
  const call = await CallHistory.findOne({ callId, status: 'answered', $or: [{ callerId: user._id }, { calleeId: user._id }] });
  if (!call) throw new AppError(404, 'CALL_NOT_ACTIVE', 'This call is not in progress');
  const other = String(call.callerId) === String(user._id) ? call.calleeId : call.callerId;
  realtime.emitToUser(String(other), 'call:signal', { callId, from: String(user._id), keyVersion, nonce, ciphertext });
}

/** Ends whatever call the person is in (used when they disappear). */
async function endActiveCallFor(userId, reason) {
  const call = await CallHistory.findOne({ active: true, $or: [{ callerId: userId }, { calleeId: userId }] });
  if (!call) return;
  const asCaller = String(call.callerId) === String(userId);
  let done;
  if (call.status === 'ringing') done = asCaller ? await transition(call.callId, ['ringing'], 'canceled', { endedReason: reason }) : null;
  else done = await transition(call.callId, ['answered'], 'ended', { endedReason: reason, durationSec: rules.durationSec(call.answeredAt, new Date()) });
  if (done) both(done, 'call:ended', { callId: call.callId, reason, by: String(userId) });
}
/** Called when someone's last connection drops. They get a short grace period to reconnect before the call is ended. */
function onUserOffline(userId) {
  setTimeout(() => {
    if (!realtime.isOnline(String(userId))) endActiveCallFor(userId, 'connection-lost').catch(() => {});
  }, rules.OFFLINE_GRACE_MS).unref?.();
}

// ---------- history (each person controls their own view) ----------
async function history(user, { before, limit }) {
  const couple = await requireActiveCouple(user);
  const q = { coupleId: couple._id, active: false, hiddenFor: { $ne: user._id } };
  if (before) q._id = { $lt: before };
  const rows = await CallHistory.find(q).sort({ _id: -1 }).limit(limit + 1);
  const page = rows.slice(0, limit);
  return { calls: page.map((c) => view(c, user._id)), nextBefore: rows.length > limit ? String(page[page.length - 1]._id) : null };
}
// Hiding removes it from YOUR list; once both of you hide it, it is deleted for good.
async function hide(user, callId) {
  const couple = await requireActiveCouple(user);
  const r = await CallHistory.updateOne({ callId, coupleId: couple._id, active: false, $or: [{ callerId: user._id }, { calleeId: user._id }] }, { $addToSet: { hiddenFor: user._id } });
  if (r.matchedCount === 0) throw new AppError(404, 'CALL_NOT_FOUND', 'No such call');
  await CallHistory.deleteOne({ callId, hiddenFor: { $all: couple.members } });
}
async function hideAll(user) {
  const couple = await requireActiveCouple(user);
  await CallHistory.updateMany({ coupleId: couple._id, active: false }, { $addToSet: { hiddenFor: user._id } });
  await CallHistory.deleteMany({ coupleId: couple._id, active: false, hiddenFor: { $all: couple.members } });
}

async function iceServers(user) {
  await requireActiveCouple(user); // only people in a room get relay credentials
  return rules.buildIceServers({ stunUrls: config.STUN_URLS, turnUrls: config.TURN_URLS, turnSecret: config.TURN_SECRET, userId: String(user._id), ttlSec: config.TURN_TTL_SECONDS });
}

module.exports = { startCall, answerCall, rejectCall, endCall, relaySignal, onUserOffline, endActiveCallFor, expire, sweepStale, history, hide, hideAll, iceServers };
