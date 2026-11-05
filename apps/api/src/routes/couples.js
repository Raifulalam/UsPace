const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { ALLOWED_TTL } = require('@couples/space-core');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/coupleService');

const view = (c) => ({
  id: c.id, name: c.name, theme: c.theme, status: c.status, keyVersion: c.keyVersion, messageTtlSec: c.messageTtlSec || 0, anniversaryDate: c.anniversaryDate || null,
  members: c.members.map((m) => (m.username ? { id: m.id, username: m.username, displayName: m.displayName || m.username } : { id: String(m) })),
});
const invView = (i) => ({
  id: i.id, status: i.status, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt || null,
  invitee: i.inviteeId && i.inviteeId.username ? { id: i.inviteeId.id, username: i.inviteeId.username, displayName: i.inviteeId.displayName || i.inviteeId.username } : null,
});
const idParam = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).strict();
const createSchema = z.object({ name: z.string().trim().min(1).max(60).default('Our Space') }).strict();
const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  theme: z.enum(['rose', 'lavender', 'midnight']).optional(),
  messageTtlSec: z.number().int().refine((v) => ALLOWED_TTL.includes(v), 'Choose off, 1 hour, 24 hours, 7 days or 30 days').optional(),
  anniversaryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00Z`)).optional(),
}).strict().refine((o) => Object.keys(o).length > 0, 'Nothing to update');

// Every route is scoped to "me". The couple id is derived from the authenticated user,
// never from the URL or body, so there is no id to guess.
router.use(authenticate);

router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
  const c = await svc.createCouple(req.user, req.body);
  res.status(201).json({ data: { couple: view(await c.populate('members', 'username displayName')) } });
}));
router.get('/me', asyncHandler(async (req, res) => {
  res.json({ data: { couple: view(await svc.getMyCouple(req.user)) } });
}));
router.patch('/me', validate(patchSchema), asyncHandler(async (req, res) => {
  await svc.updateCouple(req.user, req.body);
  res.json({ data: { couple: view(await svc.getMyCouple(req.user)) } });
}));
router.post('/me/leave', asyncHandler(async (req, res) => {
  await svc.leaveCouple(req.user);
  res.status(204).end();
}));

router.post('/me/invitations', asyncHandler(async (req, res) => {
  const { invitation, code } = await svc.createInvitation(req.user);
  res.status(201).json({ data: { invitation: invView(invitation), code } });
}));
router.get('/me/invitations', asyncHandler(async (req, res) => {
  res.json({ data: { invitations: (await svc.listInvitations(req.user)).map(invView) } });
}));
router.post('/me/invitations/:id/confirm', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  res.json({ data: { couple: view(await svc.confirmInvitation(req.user, req.params.id)) } });
}));
router.post('/me/invitations/:id/reject', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  res.json({ data: { invitation: invView(await svc.rejectInvitation(req.user, req.params.id)) } });
}));
router.delete('/me/invitations/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  await svc.revokeInvitation(req.user, req.params.id);
  res.status(204).end();
}));

module.exports = router;
