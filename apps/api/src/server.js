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
const { createApp } = require('./app');
const { attachSockets } = require('./sockets');

(async () => {
  await connectDb();
  const server = http.createServer(createApp());
  attachSockets(server);
  server.listen(config.PORT, () => console.log(`API listening on :${config.PORT}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
