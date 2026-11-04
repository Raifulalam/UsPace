const AppError = require('../utils/AppError');
const adminAuth = require('../services/adminAuthService');
const { can } = require('../admin/permissions');

async function authenticateAdmin(req, res, next) {
  try {
    const h = req.get('authorization') || '';
    req.admin = await adminAuth.authenticate(h.startsWith('Bearer ') ? h.slice(7) : null);
    next();
  } catch (e) { next(e); }
}
const requirePermission = (permission) => (req, res, next) =>
  can(req.admin.role, permission) ? next() : next(new AppError(403, 'FORBIDDEN', 'Your role cannot do this'));

module.exports = { authenticateAdmin, requirePermission };
