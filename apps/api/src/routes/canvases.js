const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const { restOpSchema, listOpsSchema, favoriteSchema } = require('../schemas/canvas');
const svc = require('../services/canvasService');
const { emitToCanvas, emitToCouple } = require('../services/realtime');

const idParam = z.object({ id: zObjectId }).strict();
router.use(authenticate);

router.post('/', asyncHandler(async (req, res) => {
  const canvas = await svc.createCanvas(req.user);
  emitToCouple(String(req.user.coupleId), 'canvas:created', { canvasId: canvas.id }); // lets partners (and the wallpaper) follow the newest canvas
  res.status(201).json({ data: { canvas } });
}));
router.get('/', asyncHandler(async (req, res) => res.json({ data: { canvases: await svc.listCanvases(req.user) } })));
router.get('/:id/ops', validate(idParam, 'params'), validate(listOpsSchema, 'query'), asyncHandler(async (req, res) => {
  res.json({ data: await svc.listOps(req.user, req.params.id, req.query) });
}));
router.post('/:id/ops', validate(idParam, 'params'), validate(restOpSchema), asyncHandler(async (req, res) => {
  const { op, created, canvasId } = await svc.appendOp(req.user, { ...req.body, canvasId: req.params.id });
  if (created) emitToCanvas(canvasId, 'canvas:op', { canvasId, op });
  res.status(created ? 201 : 200).json({ data: { op } });
}));
router.patch('/:id', validate(idParam, 'params'), validate(favoriteSchema), asyncHandler(async (req, res) => {
  res.json({ data: { canvas: await svc.setFavorite(req.user, req.params.id, req.body.favorite) } });
}));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const id = await svc.archiveCanvas(req.user, req.params.id);
  emitToCanvas(id, 'canvas:archived', { canvasId: id });
  res.status(204).end();
}));

module.exports = router;
