const AppError = require('../utils/AppError');
const settings = require('../services/settingsService');

// Platform switches controlled from the admin dashboard.
const requireFeature = (name) => async (req, res, next) => {
  try {
    if ((await settings.get()).features[name] === false) return next(new AppError(403, 'FEATURE_DISABLED', 'This feature is turned off right now'));
    next();
  } catch (e) { next(e); }
};

const maintenanceGate = async (req, res, next) => {
  try {
    const s = await settings.get();
    // The admin area and the public config stay reachable so maintenance mode can always be switched off.
    if (s.maintenance.enabled && !/^\/(admin|config)(\/|$)/.test(req.path)) return res.status(503).json({ error: { code: 'MAINTENANCE', message: s.maintenance.message } });
    next();
  } catch (e) { next(e); }
};

module.exports = { requireFeature, maintenanceGate };
