const mongoose = require('mongoose');

// Content (text, reply target, media keys, ...) lives ONLY inside `ciphertext`.
// Plaintext metadata is the minimum the server needs to route, order, expire and delete.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    clientMsgId: { type: String, required: true }, // uuid, makes sends idempotent
    keyVersion: { type: Number, required: true },
    kind: { type: String, enum: ['text', 'media', 'sticker', 'heart'], required: true },
    nonce: String,
    ciphertext: String,
    mediaIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'MediaAsset' }], // plaintext on purpose: lets the server refcount files
    editedAt: Date,
    pinnedAt: Date,
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deletedAt: Date,
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }, // disappearing messages
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, _id: -1 });
schema.index({ senderId: 1, clientMsgId: 1 }, { unique: true });
schema.index({ coupleId: 1, mediaIds: 1 });
module.exports = mongoose.model('Message', schema);
