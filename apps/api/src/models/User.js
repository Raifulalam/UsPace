const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_.]{3,24}$/ },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    birthDate: { type: Date, required: true, select: false },
    displayName: { type: String, trim: true, maxlength: 50 },
    role: { type: String, enum: ['user', 'admin', 'superadmin'], default: 'user' },
    status: { type: String, enum: ['active', 'suspended', 'pending_deletion'], default: 'active', index: true },
    emailVerifiedAt: Date,
    emailVerifyTokenHash: { type: String, select: false },
    emailVerifyExpiresAt: { type: Date, select: false },
    // Not unique: both partners share the same coupleId. "One couple per user" is enforced
    // by conditional atomic updates ({coupleId: null}) in coupleService.
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', index: true },
    resetTokenHash: { type: String, select: false },
    resetExpiresAt: { type: Date, select: false },
    resetRequestedAt: { type: Date, select: false },
    deletionRequestedAt: Date,
    deletionScheduledAt: Date,
    tokenVersion: { type: Number, default: 0 }, // bump to invalidate all access tokens
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
  },
  { timestamps: true }
);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName || u.username,
    role: u.role,
    coupleId: u.coupleId ? String(u.coupleId) : null,
    emailVerified: Boolean(u.emailVerifiedAt),
  };
}

const User = mongoose.model('User', userSchema);
module.exports = User;
module.exports.publicUser = publicUser;
