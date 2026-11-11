const mongoose = require('mongoose');

// FCM credentials are separate from the E2EE Device identity and contain no message content.
const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    platform: { type: String, enum: ['android'], default: 'android', required: true },
    token: { type: String, required: true, unique: true, trim: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

schema.index({ userId: 1, deviceId: 1 }, { unique: true });
schema.index({ userId: 1, platform: 1 });

module.exports = mongoose.model('PushToken', schema);
