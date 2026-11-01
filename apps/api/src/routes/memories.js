const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const S = require('../schemas/memories');
const svc = require('../services/memoryService');
const { emitToCouple } = require('../services/realtime');

const idParam = z.object({ id: zObjectId }).strict();
const changed = (coupleId) => emitToCouple(coupleId, 'memories:changed', {});
router.use(authenticate);

// Albums first so "albums" is never mistaken for a memory id.
router.get('/albums', asyncHandler(async (req, res) => res.json({ data: { albums: await svc.listAlbums(req.user) } })));
router.post('/albums', validate(S.albumCreateSchema), asyncHandler(async (req, res) => {
  const album = await svc.createAlbum(req.user, req.body);
  changed(String(req.user.coupleId));
  res.status(201).json({ data: { album } });
}));
router.patch('/albums/:id', validate(idParam, 'params'), validate(S.albumRenameSchema), asyncHandler(async (req, res) => {
  const album = await svc.renameAlbum(req.user, req.params.id, req.body);
  changed(String(req.user.coupleId));
  res.json({ data: { album } });
}));
router.delete('/albums/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  await svc.deleteAlbum(req.user, req.params.id);
  changed(String(req.user.coupleId));
  res.status(204).end();
}));

router.get('/', validate(S.listSchema, 'query'), asyncHandler(async (req, res) => res.json({ data: await svc.listMemories(req.user, req.query) })));
router.post('/', validate(S.createSchema), asyncHandler(async (req, res) => {
  const { memory, created, coupleId } = await svc.createMemory(req.user, req.body);
  if (created) changed(coupleId);
  res.status(created ? 201 : 200).json({ data: { memory } });
}));
router.patch('/:id', validate(idParam, 'params'), validate(S.patchSchema), asyncHandler(async (req, res) => {
  const { memory, coupleId } = await svc.updateMemory(req.user, req.params.id, req.body);
  changed(coupleId);
  res.json({ data: { memory } });
}));
router.put('/:id/favorite', validate(idParam, 'params'), validate(S.favoriteSchema), asyncHandler(async (req, res) => {
  res.json({ data: { memory: await svc.setFavorite(req.user, req.params.id, req.body.favorite) } });
}));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  changed(await svc.deleteMemory(req.user, req.params.id));
  res.status(204).end();
}));

module.exports = router;
