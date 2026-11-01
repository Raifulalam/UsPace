const mongoose = require('mongoose');

const coupleSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 60, default: 'Our Space' },
    theme: { type: String, enum: ['rose', 'lavender', 'midnight'], default: 'rose' },
    anniversaryDate: Date,
    keyVersion: { type: Number, default: 0 }, // 0 until active; bumped when a device is revoked
    members: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      validate: [(m) => m.length >= 1 && m.length <= 2, 'A couple has one or two members'],
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'active', 'closed'], default: 'pending', index: true },
    activatedAt: Date,
    storageUsed: { type: Number, default: 0 }, // bytes of encrypted media reserved or stored
    storageQuotaBytes: Number, // optional per-couple override (premium plans); default comes from config
    closedAt: Date,
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
coupleSchema.index({ members: 1, status: 1 });
module.exports = mongoose.model('Couple', coupleSchema);
