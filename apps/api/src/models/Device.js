const mongoose = require('mongoose');

// One row per browser/phone. The server only ever holds the PUBLIC key.
const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    publicKey: { type: String, required: true, unique: true, match: /^[A-Za-z0-9+/]{43}=$/ },
    label: { type: String, trim: true, maxlength: 60, required: true },
    revokedAt: Date,
    lastSeenAt: Date,
  },
  { timestamps: true }
);
schema.index({ userId: 1, revokedAt: 1 });
module.exports = mongoose.model('Device', schema);
