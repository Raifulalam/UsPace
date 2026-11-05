const mongoose = require('mongoose');

// How far each person has read. Moves forward only.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lastReadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.model('ReadState', schema);
