const router = require('express').Router();
const { z } = require('zod');
const config = require('../config/env');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { passwordSchema } = require('../schemas/password');
const account = require('../services/accountService');

const COOKIE = 'rt';
const passwordChange = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }).strict();
const deletion = z.object({ password: z.string().min(1).max(200) }).strict();
const sessionParam = z.object({ id: z.string().uuid() }).strict();
router.use(authenticate);

router.post('/me/password', validate(passwordChange), asyncHandler(async (req, res) => {
  const accessToken = await account.changePassword(req.user, req.body.currentPassword, req.body.newPassword, req.cookies?.[COOKIE]);
  res.json({ data: { accessToken } });
}));
router.get('/me/sessions', asyncHandler(async (req, res) => res.json({ data: { sessions: await account.listSessions(req.user, req.cookies?.[COOKIE]) } })));
router.post('/me/sessions/revoke-all', asyncHandler(async (req, res) => {
  await account.logoutEverywhere(req.user);
  res.clearCookie(COOKIE, { path: '/api/v1/auth', httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict' });
  res.status(204).end();
}));
router.delete('/me/sessions/:id', validate(sessionParam, 'params'), asyncHandler(async (req, res) => {
  await account.revokeSession(req.user, req.params.id);
  res.status(204).end();
}));
router.post('/me/deletion', validate(deletion), asyncHandler(async (req, res) => {
  const scheduledFor = await account.requestDeletion(req.user, req.body.password);
  res.clearCookie(COOKIE, { path: '/api/v1/auth', httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ data: { scheduledFor } });
}));
router.get('/me/export', asyncHandler(async (req, res) => {
  res.set('Content-Disposition', 'attachment; filename="our-space-account-data.json"');
  res.json({ data: await account.exportData(req.user, req.cookies?.[COOKIE]) });
}));

module.exports = router;
