const mongoose = require('mongoose');
const config = require('./env');

async function connectDb(uri = config.MONGODB_URI, opts = {}) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, opts);
  // Ensure unique/TTL indexes exist before serving traffic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}
module.exports = { connectDb };
