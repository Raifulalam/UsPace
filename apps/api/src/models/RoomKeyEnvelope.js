const mongoose = require('mongoose');

// The room key for (couple, keyVersion), encrypted to one recipient device. Opaque to the server.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    keyVersion: { type: Number, required: true, min: 1 },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    senderDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true },
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, keyVersion: 1, deviceId: 1 }, { unique: true });
schema.index({ deviceId: 1 });
module.exports = mongoose.model('RoomKeyEnvelope', schema);
