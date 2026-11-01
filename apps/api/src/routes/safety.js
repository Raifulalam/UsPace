const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/safetyService');

const username = z.string().regex(/^[a-zA-Z0-9_.]{3,24}$/);
const blockSchema = z.object({ username }).strict();
const nameParam = z.object({ username }).strict();
const reportSchema = z.object({
  category: z.enum(['harassment', 'impersonation', 'underage', 'sexual_content', 'spam', 'other']),
  target: z.enum(['partner', 'user']),
  username: username.optional(),
  details: z.string().max(1000).optional(),
  evidence: z.string().max(3000).optional(),
}).strict().refine((r) => r.target === 'partner' || r.username, { message: 'username is required when reporting another user', path: ['username'] });
router.use(authenticate);

router.get('/blocks', asyncHandler(async (req, res) => res.json({ data: { usernames: await svc.listBlocks(req.user) } })));
router.post('/blocks', validate(blockSchema), asyncHandler(async (req, res) => { await svc.blockUser(req.user, req.body.username); res.status(204).end(); }));
router.delete('/blocks/:username', validate(nameParam, 'params'), asyncHandler(async (req, res) => { await svc.unblockUser(req.user, req.params.username); res.status(204).end(); }));
router.post('/reports', validate(reportSchema), asyncHandler(async (req, res) => {
  await svc.createReport(req.user, req.body);
  res.status(201).json({ data: { message: 'Thank you. Our safety team will review your report.' } });
}));

module.exports = router;
