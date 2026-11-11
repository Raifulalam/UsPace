const router = require('express').Router();
const { z } = require('zod');
const config = require('../config/env');
const validate = require('../middleware/validate');
const { authLimiter } = require('../middleware/limiters');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const auth = require('../services/authService');
const account = require('../services/accountService');
const { publicUser } = require('../models/User');

const COOKIE = 'rt';
const cookieOpts = () => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict', // refresh cookie is never sent cross-site (CSRF defence)
  path: '/api/v1/auth',
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400000,
});
const ctx = (req) => ({ ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 200) });
const send = (res, status, { user, session }) => {
  res.cookie(COOKIE, session.refreshToken, cookieOpts());
  res.status(status).json({ data: { user: publicUser(user), accessToken: session.accessToken } });
};

const { passwordSchema: password } = require('../schemas/password');
const registerSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.]{3,24}$/, '3-24 letters, numbers, _ or .'),
  email: z.string().email().max(254),
  password,
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  displayName: z.string().trim().min(1).max(50).optional(),
  termsAccepted: z.literal(true).optional(),
  privacyAccepted: z.literal(true).optional(),
}).strict();
const loginSchema = z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(200) }).strict();
const verifySchema = z.object({ token: z.string().min(10).max(200) }).strict();

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(async (req, res) => {
  send(res, 201, await auth.register(req.body, ctx(req)));
}));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(async (req, res) => {
  send(res, 200, await auth.login(req.body, ctx(req)));
}));
router.post('/refresh', authLimiter, asyncHandler(async (req, res) => {
  send(res, 200, await auth.refresh(req.cookies?.[COOKIE], ctx(req)));
}));
router.post('/logout', asyncHandler(async (req, res) => {
  await auth.logout(req.cookies?.[COOKIE]);
  res.clearCookie(COOKIE, { ...cookieOpts(), maxAge: undefined });
  res.status(204).end();
}));
router.post('/verify-email', authLimiter, validate(verifySchema), asyncHandler(async (req, res) => {
  const user = await auth.verifyEmail(req.body.token);
  res.json({ data: { user: publicUser(user) } });
}));
const forgotSchema = z.object({ email: z.string().email().max(254) }).strict();
const resetSchema = z.object({ token: z.string().min(10).max(200), password }).strict();
const cancelSchema = z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(200) }).strict();

router.post('/password/forgot', authLimiter, validate(forgotSchema), asyncHandler(async (req, res) => {
  await account.requestPasswordReset(req.body.email);
  res.status(202).json({ data: { message: 'If that email has an account, a reset link is on its way.' } }); // identical whether or not the account exists
}));
router.post('/password/reset', authLimiter, validate(resetSchema), asyncHandler(async (req, res) => {
  await account.confirmPasswordReset(req.body.token, req.body.password);
  res.status(204).end();
}));
router.post('/deletion/cancel', authLimiter, validate(cancelSchema), asyncHandler(async (req, res) => {
  await account.cancelDeletion(req.body.identifier, req.body.password);
  res.status(204).end();
}));
router.get('/me', authenticate, (req, res) => res.json({ data: { user: publicUser(req.user) } }));

module.exports = router;
