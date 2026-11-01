const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    blockerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    blockedId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
schema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
schema.index({ blockedId: 1 });
module.exports = mongoose.model('Block', schema);
