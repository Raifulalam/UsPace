const rateLimit = require('express-rate-limit');

const skip = () => process.env.NODE_ENV === 'test';
const make = (windowMs, limit, code) =>
  rateLimit({
    windowMs, limit, skip, standardHeaders: true, legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: { code, message: 'Too many requests, slow down' } }),
  });

module.exports = {
  authLimiter: make(15 * 60 * 1000, 30, 'RATE_LIMITED'),
  // Invitation codes are guessable in principle; keep guess attempts very expensive.
  inviteAcceptLimiter: make(60 * 60 * 1000, 10, 'RATE_LIMITED'),
  generalLimiter: make(60 * 1000, 300, 'RATE_LIMITED'),
};
