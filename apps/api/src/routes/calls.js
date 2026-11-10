const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { historyQuery } = require('../schemas/calls');
const svc = require('../services/callService');

router.use(authenticate);
// Relay credentials are short-lived and tied to the signed-in person.
router.get('/ice', asyncHandler(async (req, res) => res.json({ data: { iceServers: await svc.iceServers(req.user) } })));
router.get('/history', validate(historyQuery, 'query'), asyncHandler(async (req, res) => res.json({ data: await svc.history(req.user, req.query) })));
router.delete('/history', asyncHandler(async (req, res) => { await svc.hideAll(req.user); res.status(204).end(); }));
router.delete('/history/:callId', validate(z.object({ callId: z.string().uuid() }).strict(), 'params'), asyncHandler(async (req, res) => { await svc.hide(req.user, req.params.callId); res.status(204).end(); }));

module.exports = router;
