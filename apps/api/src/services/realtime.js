let io = null;
module.exports = {
  setIo(i) { io = i; },
  // No-op when sockets are not attached (e.g. REST-only tests).
  emitToCouple(coupleId, event, payload) { if (io) io.to(`couple:${coupleId}`).emit(event, payload); },
  /** Number of distinct users with at least one open socket (for the admin overview). */
  onlineUsers() {
    if (!io) return 0;
    let n = 0;
    for (const room of io.sockets.adapter.rooms.keys()) if (room.startsWith('user:')) n++;
    return n;
  },
  emitToUser(userId, event, payload) { if (io) io.to(`user:${userId}`).emit(event, payload); },
  /** True while the person has at least one open socket (any device). */
  isOnline(userId) { return Boolean(io && io.sockets.adapter.rooms.has(`user:${userId}`)); },
  emitToCanvas(canvasId, event, payload) { if (io) io.to(`canvas:${canvasId}`).emit(event, payload); },
};
