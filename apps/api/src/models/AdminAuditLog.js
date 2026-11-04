const mongoose = require('mongoose');

// Append-only and hash-chained (see admin/auditChain.js). The model refuses every update/delete operation; the retention job never touches it.
const schema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, unique: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminAccount', default: null },
    adminEmail: { type: String, default: null },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: null },
    createdAt: { type: Date, required: true, index: true },
  },
  { timestamps: false }
);
const forbid = function () { throw new Error('The audit log is append-only'); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace']) schema.pre(op, forbid);
schema.pre('save', function () { if (!this.isNew) throw new Error('The audit log is append-only'); });
module.exports = mongoose.model('AdminAuditLog', schema);
