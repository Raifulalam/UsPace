const User = require('../models/User');
const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/tokens');

// Verifies the JWT AND re-loads the user, so suspensions and tokenVersion bumps
// take effect immediately instead of waiting for the access token to expire.
async function authenticateToken(token) {
  if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
  }
  const user = await User.findById(payload.sub);
  if (!user || user.tokenVersion !== payload.tv) throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
  if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Account is not active');
  return user;
}

const authenticate = async (req, res, next) => {
  try {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    req.user = await authenticateToken(token);
    next();
  } catch (e) {
    next(e);
  }
};

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));

module.exports = { authenticate, authenticateToken, requireRole };
