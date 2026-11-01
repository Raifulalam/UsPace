const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    coupleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Couple', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    clientAlbumId: { type: String, required: true },
    keyVersion: { type: Number, required: true },
    nonce: { type: String, required: true },
    ciphertext: { type: String, required: true }, // the album name
    deletedAt: Date,
  },
  { timestamps: true }
);
schema.index({ coupleId: 1, deletedAt: 1, createdAt: 1 });
schema.index({ createdBy: 1, clientAlbumId: 1 }, { unique: true });
module.exports = mongoose.model('Album', schema);
