const mongoose = require('mongoose');

// Reports are read by the Super Admin team. Because content is end-to-end encrypted, the server cannot see what was said:
// `evidence` is only what the reporter chose to include, and cannot be verified. Kept after account deletion for safety/legal reasons.
const schema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    targetUsername: { type: String, required: true },
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple' },
    category: { type: String, enum: ['harassment', 'impersonation', 'underage', 'sexual_content', 'spam', 'other'], required: true },
    details: { type: String, maxlength: 1000, default: '' },
    evidence: { type: String, maxlength: 3000, default: '' },
    status: { type: String, enum: ['open', 'reviewing', 'actioned', 'dismissed'], default: 'open' },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    handledAt: Date,
    resolution: { type: String, maxlength: 1000 },
  },
  { timestamps: true }
);
schema.index({ status: 1, createdAt: -1 });
schema.index({ reporterId: 1, createdAt: -1 });
schema.index({ targetUserId: 1 });
module.exports = mongoose.model('Report', schema);
