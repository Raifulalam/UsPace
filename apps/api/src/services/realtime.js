let io = null;
module.exports = {
  setIo(i) { io = i; },
  // No-op when sockets are not attached (e.g. REST-only tests).
  emitToCouple(coupleId, event, payload) { if (io) io.to(`couple:${coupleId}`).emit(event, payload); },
  emitToCanvas(canvasId, event, payload) { if (io) io.to(`canvas:${canvasId}`).emit(event, payload); },
};
