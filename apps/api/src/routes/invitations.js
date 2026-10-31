const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { inviteAcceptLimiter } = require('../middleware/limiters');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/coupleService');

const acceptSchema = z.object({ code: z.string().min(10).max(14) }).strict();
router.use(authenticate);

router.post('/accept', inviteAcceptLimiter, validate(acceptSchema), asyncHandler(async (req, res) => {
  const inv = await svc.acceptInvitation(req.user, req.body.code);
  res.json({ data: { invitation: { id: inv.id, status: inv.status }, message: 'Waiting for your partner to confirm' } });
}));
router.get('/mine', asyncHandler(async (req, res) => {
  const list = await svc.myAcceptedInvitations(req.user);
  res.json({ data: { invitations: list.map((i) => ({ id: i.id, status: i.status, expiresAt: i.expiresAt })) } });
}));

module.exports = router;
