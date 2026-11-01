const mongoose = require('mongoose');

// One encrypted file (or encrypted thumbnail). The server never learns its type, name or content:
// the file key and descriptor live inside encrypted messages / memories.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    uploaderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['image', 'video', 'audio', 'thumb'], required: true }, // declared size class only
    sizeBytes: { type: Number, required: true }, // exact ciphertext size, reserved against quota at creation
    storageKey: { type: String, required: true },
    status: { type: String, enum: ['pending', 'uploading', 'ready', 'deleted'], default: 'pending' },
    readyAt: Date,
    deletedAt: Date,
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, status: 1 });
schema.index({ status: 1, createdAt: 1 });
module.exports = mongoose.model('MediaAsset', schema);
