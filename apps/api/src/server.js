// Run with: node --env-file=.env src/server.js   (Node >= 20.6, no dotenv dependency needed)
const http = require('http');
const config = require('./config/env');
const { connectDb } = require('./config/db');

require('./models/User');
require('./models/Couple');
require('./models/Invitation');
require('./models/RefreshToken');
require('./models/Device');
require('./models/RoomKeyEnvelope');
require('./models/Message');
require('./models/RecoveryBlob');
require('./models/Canvas');
require('./models/CanvasOp');
require('./models/MediaAsset');
require('./models/Memory');
require('./models/Album');
require('./models/Block');
require('./models/Report');
require('./models/AdminAccount');
require('./models/AdminSession');
require('./models/AdminAuditLog');
require('./models/ApplicationSettings');
require('./models/MessageReaction');
require('./models/ReadState');
require('./models/CallHistory');
const { createApp } = require('./app');
const { attachSockets } = require('./sockets');

(async () => {
  await connectDb();
  const server = http.createServer(createApp());
  attachSockets(server);
  server.listen(config.PORT, () => console.log(`API listening on :${config.PORT}`));
  // Housekeeping for abandoned uploads / unreferenced files (see mediaService.sweep).
  setInterval(() => require('./services/mediaService').sweep().catch((e) => console.error('media sweep failed', e.message)), 30 * 60 * 1000).unref();
  // Closes calls whose end event was lost (server restart, crash).
  setInterval(() => require('./services/callService').sweepStale().catch((e) => console.error('call sweep failed', e.message)), 5 * 60 * 1000).unref();
  // Permanent-deletion job (closed rooms after 30 days, deleted accounts after the 14-day grace period).
  setInterval(() => require('./services/retentionService').sweep().catch((e) => console.error('retention sweep failed', e.message)), 6 * 60 * 60 * 1000).unref();
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
