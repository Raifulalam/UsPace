const mongoose = require('mongoose');

// A shared drawing. Everything drawn lives in CanvasOp as ciphertext; the server only knows counts and ordering.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    seq: { type: Number, default: 0 }, // last assigned op sequence number
    opCount: { type: Number, default: 0 },
    favoritedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    archivedAt: Date,
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, archivedAt: 1, createdAt: 1 });
module.exports = mongoose.model('Canvas', schema);
