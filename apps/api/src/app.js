const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const { generalLimiter } = require('./middleware/limiters');
const { requireFeature, maintenanceGate } = require('./middleware/features');
const settings = require('./services/settingsService');
const asyncHandler = require('./utils/asyncHandler');
const { notFound, errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  const origins = [config.CLIENT_ORIGIN, config.ADMIN_ORIGIN, ...config.ADDITIONAL_CLIENT_ORIGINS];
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one reverse proxy/load balancer
  app.use(helmet());
  app.use(cors({ origin: origins, credentials: true, exposedHeaders: ['Content-Length'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(generalLimiter);

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api/v1', maintenanceGate); // when maintenance mode is on, everything except /admin and /config answers 503
  app.get('/api/v1/config', asyncHandler(async (req, res) => res.json({ data: settings.publicConfig(await settings.get()) })));
  app.use('/api/v1/admin', require('./routes/admin'));
  app.use('/api/v1/auth', require('./routes/auth'));
  app.use('/api/v1/couples', require('./routes/couples'));
  app.use('/api/v1/invitations', require('./routes/invitations'));
  app.use('/api/v1/devices', require('./routes/devices'));
  app.use('/api/v1/push-tokens', require('./routes/pushTokens'));
  app.use('/api/v1/keys', require('./routes/keys'));
  app.use('/api/v1/messages', requireFeature('chat'), require('./routes/messages'));
  app.use('/api/v1/calls', requireFeature('calls'), require('./routes/calls'));
  app.use('/api/v1/canvases', requireFeature('canvas'), require('./routes/canvases'));
  app.use('/api/v1/media', requireFeature('media'), require('./routes/media'));
  app.use('/api/v1/users', require('./routes/users'));
  app.use('/api/v1/safety', require('./routes/safety'));
  app.use('/api/v1/memories', requireFeature('memories'), require('./routes/memories'));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
