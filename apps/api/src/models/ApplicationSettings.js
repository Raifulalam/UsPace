const mongoose = require('mongoose');

// One document holding platform settings. Shape and bounds are enforced by settingsService (zod), defaults are merged on read.
const schema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: 'main' },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: String },
  },
  { timestamps: true }
);
module.exports = mongoose.model('ApplicationSettings', schema);
