const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { inviteAcceptLimiter } = require('../middleware/limiters');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/coupleService');
const { notifyUsers } = require('../services/pushNotificationService');

const acceptSchema = z.object({ code: z.string().min(10).max(14) }).strict();
router.use(authenticate);

router.post('/accept', inviteAcceptLimiter, validate(acceptSchema), asyncHandler(async (req, res) => {
  const inv = await svc.acceptInvitation(req.user, req.body.code);
  notifyUsers({
    userIds: [inv.inviterId],
    type: 'invitation',
    title: 'UsPace',
    body: 'Your invitation was accepted and is waiting for confirmation.',
    destination: '/space',
    eventId: `invitation-accepted:${inv.id}`,
  }).catch((error) => console.error('push notification delivery failed', error));
  res.json({ data: { invitation: { id: inv.id, status: inv.status }, message: 'Waiting for your partner to confirm' } });
}));
router.get('/mine', asyncHandler(async (req, res) => {
  const list = await svc.myAcceptedInvitations(req.user);
  res.json({ data: { invitations: list.map((i) => ({ id: i.id, status: i.status, expiresAt: i.expiresAt })) } });
}));

module.exports = router;
