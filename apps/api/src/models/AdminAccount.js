const mongoose = require('mongoose');

// Admins are a SEPARATE kind of account from couples-app users: different collection, different login, different token
// secret and audience. A leaked or hijacked user session can never become an admin session.
const schema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ['superadmin', 'moderator', 'support'], required: true },
    status: { type: String, enum: ['invited', 'active', 'disabled'], default: 'invited' },
    setupTokenHash: { type: String, select: false },
    setupExpiresAt: { type: Date, select: false },
    mfaEnabled: { type: Boolean, default: false },
    mfaSecretEnc: { type: String, select: false }, // AES-GCM sealed authenticator seed
    mfaPendingEnc: { type: String, select: false }, // seed shown during enrolment, not yet confirmed
    mfaLastStep: { type: Number, default: 0 }, // last accepted 30-second step: a code cannot be used twice
    recoveryHashes: { type: [String], select: false },
    failedLogins: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
    lastLoginIp: String,
    tokenVersion: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminAccount' },
  },
  { timestamps: true }
);
module.exports = mongoose.model('AdminAccount', schema);
