const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const { generalLimiter } = require('./middleware/limiters');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one reverse proxy/load balancer
  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(generalLimiter);

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api/v1/auth', require('./routes/auth'));
  app.use('/api/v1/couples', require('./routes/couples'));
  app.use('/api/v1/invitations', require('./routes/invitations'));
  app.use('/api/v1/devices', require('./routes/devices'));
  app.use('/api/v1/keys', require('./routes/keys'));
  app.use('/api/v1/messages', require('./routes/messages'));
  app.use('/api/v1/canvases', require('./routes/canvases'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
