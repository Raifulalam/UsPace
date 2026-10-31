const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const { sendSchema, listSchema } = require('../schemas/messages');
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
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { message, coupleId } = await svc.deleteMessage(req.user, req.params.id);
  emitToCouple(coupleId, 'message:deleted', { id: message.id });
  res.status(204).end();
}));

module.exports = router;
