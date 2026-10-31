const mongoose = require('mongoose');

// pending   -> created by inviter, code not yet used
// accepted  -> invitee entered the code, waiting for inviter confirmation
// confirmed -> inviter confirmed; couple became active
// rejected / revoked / expired -> terminal
const invitationSchema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    inviterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inviteeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    codeHash: { type: String, required: true, unique: true }, // plaintext code is never stored
    status: {
      type: String,
      enum: ['pending', 'accepted', 'confirmed', 'rejected', 'revoked', 'expired'],
      default: 'pending',
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: Date,
    resolvedAt: Date,
    purgeAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } }, // expiresAt + 30d
  },
  { timestamps: true }
);
invitationSchema.index({ coupleId: 1, status: 1 });
invitationSchema.index({ inviteeId: 1, status: 1 });
module.exports = mongoose.model('Invitation', invitationSchema);
