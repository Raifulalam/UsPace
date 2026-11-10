const mongoose = require('mongoose');

// Who called whom, when, for how long. Never any content: calls go straight between the two phones.
const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    callId: { type: String, required: true, unique: true }, // uuid chosen by the caller
    callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    calleeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['audio', 'video'], required: true },
    status: { type: String, enum: ['ringing', 'answered', 'ended', 'missed', 'rejected', 'canceled', 'failed'], required: true },
    active: { type: Boolean, default: false }, // true while ringing or in progress
    startedAt: { type: Date, required: true },
    answeredAt: Date,
    endedAt: Date,
    durationSec: { type: Number, default: 0 },
    endedReason: String,
    hiddenFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // each person can hide an entry from their own history
  },
  { timestamps: false }
);
// A room can have only ONE call in progress. The database enforces it, so two simultaneous "start call" requests cannot both succeed.
schema.index({ coupleId: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ coupleId: 1, startedAt: -1 });
schema.index({ active: 1, startedAt: 1 });
module.exports = mongoose.model('CallHistory', schema);
