const { z } = require('zod');
const { MEMORY_TYPES } = require('@couples/media-core');
const { zB64Bytes, zB64Len, zObjectId } = require('../utils/b64');

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'Invalid date');
const encrypted = { keyVersion: z.number().int().min(1), nonce: zB64Bytes(24), ciphertext: zB64Len(24, 60000) };

const createSchema = z.object({
  clientMemoryId: z.string().uuid(),
  type: z.enum(MEMORY_TYPES),
  eventDate: dateOnly,
  albumId: zObjectId.optional(),
  mediaIds: z.array(zObjectId).max(4).optional(),
  canvasId: zObjectId.optional(),
  downloadLocked: z.boolean().optional(),
  ...encrypted,
}).strict();

const patchSchema = z.object({
  eventDate: dateOnly.optional(),
  albumId: zObjectId.nullable().optional(),
  downloadLocked: z.boolean().optional(),
  mediaIds: z.array(zObjectId).max(4).optional(),
  keyVersion: encrypted.keyVersion.optional(),
  nonce: encrypted.nonce.optional(),
  ciphertext: encrypted.ciphertext.optional(),
}).strict().refine((o) => Object.keys(o).length > 0, 'Nothing to update')
  .refine((o) => (o.keyVersion === undefined) === (o.nonce === undefined) && (o.nonce === undefined) === (o.ciphertext === undefined), 'keyVersion, nonce and ciphertext go together')
  .refine((o) => o.mediaIds === undefined || o.ciphertext !== undefined, 'Changing media requires the re-encrypted content too');

const listSchema = z.object({
  type: z.enum(MEMORY_TYPES).optional(),
  favorite: z.enum(['true']).optional(),
  albumId: zObjectId.optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const favoriteSchema = z.object({ favorite: z.boolean() }).strict();
const albumCreateSchema = z.object({ clientAlbumId: z.string().uuid(), ...encrypted }).strict();
const albumRenameSchema = z.object({ ...encrypted }).strict();

module.exports = { createSchema, patchSchema, listSchema, favoriteSchema, albumCreateSchema, albumRenameSchema };
