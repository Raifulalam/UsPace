const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const { sendSchema, listSchema, editSchema, reactionSchema, readSchema } = require('../schemas/messages');
const svc = require('../services/messageService');
const { emitToCouple } = require('../services/realtime');

const idParam = z.object({ id: zObjectId }).strict();
router.use(authenticate);

router.post('/', validate(sendSchema), asyncHandler(async (req, res) => {
  const { message, created, coupleId } = await svc.sendMessage(req.user, req.body);
  if (created) emitToCouple(coupleId, 'message:new', message);
  res.status(created ? 201 : 200).json({ data: { message } });
}));
router.get('/', validate(listSchema, 'query'), asyncHandler(async (req, res) => {
  res.json({ data: await svc.listMessages(req.user, req.query) });
}));
router.get('/pinned', asyncHandler(async (req, res) => res.json({ data: { messages: await svc.listPinned(req.user) } })));
router.get('/read-state', asyncHandler(async (req, res) => res.json({ data: await svc.readState(req.user) })));
router.put('/read', validate(readSchema), asyncHandler(async (req, res) => res.json({ data: await svc.markRead(req.user, req.body.upTo) })));
router.patch('/:id', validate(idParam, 'params'), validate(editSchema), asyncHandler(async (req, res) => res.json({ data: { message: await svc.editMessage(req.user, req.params.id, req.body) } })));
router.put('/:id/pin', validate(idParam, 'params'), asyncHandler(async (req, res) => res.json({ data: { message: await svc.setPinned(req.user, req.params.id, true) } })));
router.delete('/:id/pin', validate(idParam, 'params'), asyncHandler(async (req, res) => res.json({ data: { message: await svc.setPinned(req.user, req.params.id, false) } })));
router.put('/:id/reaction', validate(idParam, 'params'), validate(reactionSchema), asyncHandler(async (req, res) => res.json({ data: { reaction: await svc.setReaction(req.user, req.params.id, req.body) } })));
router.delete('/:id/reaction', validate(idParam, 'params'), asyncHandler(async (req, res) => { await svc.removeReaction(req.user, req.params.id); res.status(204).end(); }));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { message, coupleId } = await svc.deleteMessage(req.user, req.params.id);
  emitToCouple(coupleId, 'message:deleted', { id: message.id });
  res.status(204).end();
}));

module.exports = router;
