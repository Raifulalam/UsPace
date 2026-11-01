const mongoose = require('mongoose');
const { MEMORY_TYPES } = require('@couples/media-core');

// Titles, captions, letters and file descriptors are inside `ciphertext`. Plaintext metadata is only what the
// server needs to filter, order, paginate and refcount: type, event date, album, media ids, favorites.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientMemoryId: { type: String, required: true }, // uuid: idempotency + bound into the encryption AAD
    type: { type: String, enum: MEMORY_TYPES, required: true }, // immutable; bound into the AAD
    eventDate: { type: Date, required: true },
    albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album' },
    mediaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset' }],
    canvasId: { type: mongoose.Schema.Types.ObjectId, ref: 'Canvas' },
    favoritedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    downloadLocked: { type: Boolean, default: false }, // advisory: hides download buttons; cannot stop a partner who can decrypt
    keyVersion: { type: Number, required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true },
    deletedAt: Date,
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, deletedAt: 1, eventDate: -1, _id: -1 });
schema.index({ coupleId: 1, type: 1, eventDate: -1 });
schema.index({ createdBy: 1, clientMemoryId: 1 }, { unique: true });
schema.index({ coupleId: 1, mediaIds: 1 });
module.exports = mongoose.model('Memory', schema);
