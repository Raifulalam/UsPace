const { Server } = require('socket.io');
const config = require('../config/env');
const Couple = require('../models/Couple');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
const { setIo, emitToCouple, emitToCanvas } = require('../services/realtime');
const canvases = require('../services/canvasService');
const { opSchema, liveSchema, joinSchema } = require('../schemas/canvas');
const settings = require('../services/settingsService');
const calls = require('../services/callService');
const { startSchema, idSchema, signalSchema } = require('../schemas/calls');
const messages = require('../services/messageService');
const { sendSchema } = require('../schemas/messages');

const RECHECK_MS = 15000;

// Tiny per-socket sliding-window limiter. Replace with a Redis-backed one when scaling out.
function allow(socket, key, limit, windowMs) {
  const b = (socket.data.buckets ||= {});
  const t = Date.now();
  const arr = (b[key] = (b[key] || []).filter((x) => t - x < windowMs));
  if (arr.length >= limit) return false;
  arr.push(t);
  return true;
}

// Re-verifies membership against the database. The room name is derived server-side from the
// user's own record; a client can never name a room.
async function ensureMember(socket) {
  const { user, coupleId, verifiedAt } = socket.data;
  if (!coupleId) return false;
  if (Date.now() - verifiedAt < RECHECK_MS) return true;
  const fresh = await User.findById(user.id).select('coupleId status');
  const couple = fresh && fresh.status === 'active' && fresh.coupleId && String(fresh.coupleId) === coupleId
    ? await Couple.findOne({ _id: coupleId, members: user._id, status: 'active' }).select('_id')
    : null;
  if (!couple) {
    socket.leave(`couple:${coupleId}`);
    for (const id of socket.data.canvases || []) socket.leave(`canvas:${id}`);
    socket.data.canvases = new Set();
    socket.data.coupleId = null;
    return false;
  }
  socket.data.verifiedAt = Date.now();
  return true;
}

function attachSockets(httpServer) {
  const io = new Server(httpServer, { cors: { origin: config.CLIENT_ORIGIN, credentials: true } });
  setIo(io);

  io.use(async (socket, next) => {
    try {
      if ((await settings.get()).maintenance.enabled) return next(new Error('maintenance'));
      socket.data.user = await authenticateToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user.id}`);

    // Client sends NO room id. We look up the couple from the authenticated user.
    socket.on('couple:join', async (ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const fresh = await User.findById(user.id).select('coupleId');
        const couple = fresh?.coupleId
          ? await Couple.findOne({ _id: fresh.coupleId, members: user._id, status: 'active' }).select('_id')
          : null;
        if (!couple) return reply({ ok: false, error: 'NO_ACTIVE_COUPLE' });
        socket.data.coupleId = String(couple._id);
        socket.data.verifiedAt = Date.now();
        socket.join(`couple:${couple._id}`);
        socket.to(`couple:${couple._id}`).emit('presence:update', { userId: user.id, online: true });
        reply({ ok: true });
      } catch {
        reply({ ok: false, error: 'INTERNAL' });
      }
    });

    // Example of the pattern every later event (message:send, drawing:stroke, call:*) follows:
    // rate-limit -> ensureMember -> emit only to the server-derived room, sender id from the session.
    for (const [evt, typing] of [['typing:start', true], ['typing:stop', false]]) {
      socket.on(evt, async () => {
        if (!allow(socket, 'typing', 20, 10000)) return;
        if (!(await ensureMember(socket))) return;
        socket.to(`couple:${socket.data.coupleId}`).emit('typing:update', { userId: user.id, typing });
      });
    }

    // Encrypted message send. The server validates shape and authorization, never content.
    socket.on('message:send', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'msg', 30, 10000)) return reply({ ok: false, error: 'RATE_LIMITED' });
      if ((await settings.get()).features.chat === false) return reply({ ok: false, error: 'FEATURE_DISABLED' });
      const parsed = sendSchema.safeParse(payload);
      if (!parsed.success) return reply({ ok: false, error: 'VALIDATION_ERROR' });
      try {
        if (!(await ensureMember(socket))) return reply({ ok: false, error: 'NO_ACTIVE_COUPLE' });
        const { message, created, coupleId } = await messages.sendMessage(socket.data.user, parsed.data);
        if (created) emitToCouple(coupleId, 'message:new', message);
        reply({ ok: true, message });
      } catch (e) {
        reply({ ok: false, error: e.code || 'INTERNAL', details: e.details });
      }
    });

    // ---- Live Love Canvas ----
    // Join is the ONLY place a canvas id is checked against the database; later events require having joined.
    socket.on('canvas:join', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'cjoin', 20, 10000)) return reply({ ok: false, error: 'RATE_LIMITED' });
      const p = joinSchema.safeParse(payload);
      if (!p.success) return reply({ ok: false, error: 'VALIDATION_ERROR' });
      try {
        if ((await settings.get()).features.canvas === false) return reply({ ok: false, error: 'FEATURE_DISABLED' });
        if (!(await ensureMember(socket))) return reply({ ok: false, error: 'NO_ACTIVE_COUPLE' });
        const { canvas } = await canvases.getCanvasForUser(socket.data.user, p.data.canvasId);
        socket.join(`canvas:${canvas.id}`);
        (socket.data.canvases ||= new Set()).add(canvas.id);
        reply({ ok: true, seq: canvas.seq });
      } catch (e) {
        reply({ ok: false, error: e.code || 'INTERNAL' });
      }
    });
    socket.on('canvas:leave', (payload) => {
      const p = joinSchema.safeParse(payload);
      if (!p.success) return;
      socket.leave(`canvas:${p.data.canvasId}`);
      socket.data.canvases?.delete(p.data.canvasId);
    });
    // Persisted, ordered, encrypted drawing operation.
    socket.on('canvas:op', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'cop', 40, 10000)) return reply({ ok: false, error: 'RATE_LIMITED' });
      const p = opSchema.safeParse(payload);
      if (!p.success) return reply({ ok: false, error: 'VALIDATION_ERROR' });
      if (!socket.data.canvases?.has(p.data.canvasId)) return reply({ ok: false, error: 'NOT_JOINED' });
      try {
        if ((await settings.get()).features.canvas === false) return reply({ ok: false, error: 'FEATURE_DISABLED' });
        if (!(await ensureMember(socket))) return reply({ ok: false, error: 'NO_ACTIVE_COUPLE' });
        const { op, created, canvasId } = await canvases.appendOp(socket.data.user, p.data);
        if (created) emitToCanvas(canvasId, 'canvas:op', { canvasId, op });
        reply({ ok: true, op });
      } catch (e) {
        reply({ ok: false, error: e.code || 'INTERNAL', details: e.details });
      }
    });
    // Ephemeral encrypted preview (in-progress strokes / typed text). Never stored; dropped under load.
    socket.on('canvas:live', async (payload) => {
      if (!allow(socket, 'clive', 150, 1000)) return;
      const p = liveSchema.safeParse(payload);
      if (!p.success || !socket.data.canvases?.has(p.data.canvasId)) return;
      if (!(await ensureMember(socket))) return;
      // senderId comes from the authenticated session, never from the client.
      socket.to(`canvas:${p.data.canvasId}`).volatile.emit('canvas:live', { ...p.data, senderId: user.id });
    });

    // ---- Voice and video calls (control + encrypted setup relay only; media goes phone-to-phone) ----
    const callEvent = (name, schema, limit, run) => socket.on(name, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, name, limit, 60000)) return reply({ ok: false, error: 'RATE_LIMITED' });
      const p = schema.safeParse(payload);
      if (!p.success) return reply({ ok: false, error: 'VALIDATION_ERROR' });
      try {
        if ((await settings.get()).features.calls === false) return reply({ ok: false, error: 'FEATURE_DISABLED' });
        if (!(await ensureMember(socket))) return reply({ ok: false, error: 'NO_ACTIVE_COUPLE' });
        reply({ ok: true, ...(await run(socket.data.user, p.data)) });
      } catch (e) {
        reply({ ok: false, error: e.code || 'INTERNAL' });
      }
    });
    callEvent('call:start', startSchema, 6, (u, d) => calls.startCall(u, d));
    callEvent('call:answer', idSchema, 12, async (u, d) => ({ call: await calls.answerCall(u, d.callId) }));
    callEvent('call:reject', idSchema, 12, async (u, d) => { await calls.rejectCall(u, d.callId); return {}; });
    callEvent('call:end', idSchema, 12, async (u, d) => { await calls.endCall(u, d.callId); return {}; });
    callEvent('call:signal', signalSchema, 600, async (u, d) => { await calls.relaySignal(u, d); return {}; });

    socket.on('disconnect', async () => {
      const remaining = await io.in(`user:${user.id}`).fetchSockets();
      if (remaining.length > 0) return;
      calls.onUserOffline(user.id); // a dropped connection ends their call after a short grace period
      const coupleId = socket.data.coupleId;
      if (coupleId) io.to(`couple:${coupleId}`).emit('presence:update', { userId: user.id, online: false });
    });
  });
  return io;
}
module.exports = { attachSockets };
