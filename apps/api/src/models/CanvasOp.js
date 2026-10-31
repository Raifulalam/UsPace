const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    canvasId: { type: mongoose.Schema.Types.ObjectId, ref: 'Canvas', required: true },
    seq: { type: Number, required: true }, // assigned by the server; defines drawing order
    clientOpId: { type: String, required: true }, // uuid; makes retries idempotent
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    keyVersion: { type: Number, required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ canvasId: 1, seq: 1 }, { unique: true });
schema.index({ senderId: 1, clientOpId: 1 }, { unique: true });
module.exports = mongoose.model('CanvasOp', schema);
