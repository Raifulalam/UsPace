const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminAccount', required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyStartedAt: { type: Date, required: true }, // sessions end 8 hours after sign-in no matter how active
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }, // and after 30 idle minutes
    revokedAt: Date,
    ip: String,
    userAgent: String,
  },
  { timestamps: true }
);
module.exports = mongoose.model('AdminSession', schema);
