const Couple = require('../models/Couple');
const AppError = require('../utils/AppError');

async function requireActiveCouple(user) {
  if (!user.coupleId) throw new AppError(404, 'NO_ACTIVE_COUPLE', 'You are not in an active couple room');
  const couple = await Couple.findOne({ _id: user.coupleId, members: user._id, status: 'active' });
  if (!couple) throw new AppError(404, 'NO_ACTIVE_COUPLE', 'You are not in an active couple room');
  return couple;
}
module.exports = { requireActiveCouple };
