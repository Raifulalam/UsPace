const mongoose = require('mongoose');

// One reaction per person per message. The emoji itself is encrypted; the server only knows that this person reacted.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    keyVersion: { type: Number, required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true },
  },
  { timestamps: true }
);
schema.index({ messageId: 1, userId: 1 }, { unique: true });
schema.index({ coupleId: 1 });
module.exports = mongoose.model('MessageReaction', schema);
