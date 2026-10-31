const mongoose = require('mongoose');

// Room keys encrypted with a recovery key only the user holds. The server cannot open it.
const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    version: { type: Number, default: 1 },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true, maxlength: 90000 },
  },
  { timestamps: true }
);
module.exports = mongoose.model('RecoveryBlob', schema);
