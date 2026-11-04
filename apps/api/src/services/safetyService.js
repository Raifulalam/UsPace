const User = require('../models/User');
const Couple = require('../models/Couple');
const Block = require('../models/Block');
const Report = require('../models/Report');
const AppError = require('../utils/AppError');

const settings = require('./settingsService');

// Blocking never reveals whether the username exists: it always looks like it worked.
async function blockUser(user, username) {
  const target = await User.findOne({ username: String(username).toLowerCase() }).select('_id');
  if (target && !target._id.equals(user._id)) await Block.updateOne({ blockerId: user._id, blockedId: target._id }, { $setOnInsert: {} }, { upsert: true });
}
async function unblockUser(user, username) {
  const target = await User.findOne({ username: String(username).toLowerCase() }).select('_id');
  if (target) await Block.deleteOne({ blockerId: user._id, blockedId: target._id });
}
async function listBlocks(user) {
  const rows = await Block.find({ blockerId: user._id }).populate('blockedId', 'username').sort({ createdAt: -1 });
  return rows.map((b) => b.blockedId?.username).filter(Boolean);
}
async function isBlockedEitherWay(a, b) {
  return Boolean(await Block.exists({ $or: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }));
}

async function createReport(user, { category, target, username, details, evidence }) {
  if ((await Report.countDocuments({ reporterId: user._id, createdAt: { $gt: new Date(Date.now() - 86400000) } })) >= (await settings.get()).limits.reportsPerDay) {
    throw new AppError(429, 'TOO_MANY_REPORTS', 'You have sent several reports today. Our team will review them.');
  }
  let targetUser = null;
  let coupleId;
  if (target === 'partner') {
    const couple = user.coupleId ? await Couple.findOne({ _id: user.coupleId, members: user._id }) : null;
    const otherId = couple?.members.find((m) => !m.equals(user._id));
    if (!otherId) throw new AppError(404, 'NO_PARTNER', 'You do not have a partner to report');
    targetUser = await User.findById(otherId).select('username');
    coupleId = couple._id;
  } else {
    targetUser = await User.findOne({ username: String(username).toLowerCase() }).select('username');
  }
  // A report about an unknown username is still stored (the team can investigate) but nothing tells the reporter whether it matched.
  await Report.create({
    reporterId: user._id, targetUserId: targetUser?._id, targetUsername: targetUser?.username ?? String(username).toLowerCase(),
    coupleId, category, details: details || '', evidence: evidence || '',
  });
}

module.exports = { blockUser, unblockUser, listBlocks, isBlockedEitherWay, createReport };
