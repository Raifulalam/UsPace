const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { zObjectId } = require('../utils/b64');
const svc = require('../services/mediaService');

const createSchema = z.object({ kind: z.enum(['image', 'video', 'audio', 'thumb']), sizeBytes: z.number().int().min(1).max(200 * 1024 * 1024) }).strict();
const idParam = z.object({ id: zObjectId }).strict();
router.use(authenticate);

router.get('/usage', asyncHandler(async (req, res) => res.json({ data: await svc.usage(req.user) })));
router.post('/', validate(createSchema), asyncHandler(async (req, res) => res.status(201).json({ data: { asset: await svc.createAsset(req.user, req.body) } })));
// The body is the raw ciphertext stream; express.json never touches application/octet-stream.
router.put('/:id/blob', validate(idParam, 'params'), asyncHandler(async (req, res) => res.json({ data: { asset: await svc.uploadBlob(req.user, req.params.id, req) } })));
router.get('/:id/blob', validate(idParam, 'params'), asyncHandler(async (req, res) => {
  const { asset, stream } = await svc.openBlob(req.user, req.params.id);
  // Always opaque bytes: never rendered by the browser, never executable, never sniffed.
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(asset.sizeBytes),
    'Content-Disposition': 'attachment; filename="blob.bin"',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}));
router.delete('/:id', validate(idParam, 'params'), asyncHandler(async (req, res) => { await svc.deleteOwn(req.user, req.params.id); res.status(204).end(); }));

module.exports = router;
