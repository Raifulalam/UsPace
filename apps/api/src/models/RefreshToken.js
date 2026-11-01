const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    familyId: { type: String, required: true, index: true }, // one family per login/device
    parentFamilyId: { type: String, index: true }, // set on a native-app session: the web session family it was handed off from
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    revokedAt: Date,
    userAgent: String,
    ip: String,
  },
  { timestamps: true }
);
module.exports = mongoose.model('RefreshToken', schema);
