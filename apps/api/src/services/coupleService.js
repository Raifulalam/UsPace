const config = require('../config/env');
const User = require('../models/User');
const Couple = require('../models/Couple');
const Invitation = require('../models/Invitation');
const AppError = require('../utils/AppError');
const { generateInviteCode, hashInviteCode } = require('../utils/crypto');
const safety = require('./safetyService');
const MAX_INVITES_PER_DAY = 10;

const MAX_OPEN_INVITES = 3;
const now = () => new Date();

function assertVerified(user) {
  if (config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerifiedAt) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email first');
  }
}

async function getMyCouple(user) {
  if (!user.coupleId) throw new AppError(404, 'NO_COUPLE', 'You are not in a couple room');
  // Membership is checked in the query itself; a client-supplied id is never used.
  const couple = await Couple.findOne({ _id: user.coupleId, members: user._id, status: { $ne: 'closed' } }).populate(
    'members',
    'username displayName'
  );
  if (!couple) throw new AppError(404, 'NO_COUPLE', 'You are not in a couple room');
  return couple;
}

async function createCouple(user, { name }) {
  assertVerified(user);
  if (user.coupleId) throw new AppError(409, 'ALREADY_IN_COUPLE', 'You already have a couple room');
  const couple = await Couple.create({ name, members: [user._id], createdBy: user._id });
  // Atomic guard: only succeeds if the user still has no couple (race-safe).
  const r = await User.updateOne({ _id: user._id, coupleId: null }, { $set: { coupleId: couple._id } });
  if (r.modifiedCount !== 1) {
    await Couple.deleteOne({ _id: couple._id });
    throw new AppError(409, 'ALREADY_IN_COUPLE', 'You already have a couple room');
  }
  return couple;
}

async function updateCouple(user, patch) {
  const couple = await Couple.findOneAndUpdate(
    { _id: user.coupleId, members: user._id, status: { $ne: 'closed' } },
    { $set: patch },
    { new: true }
  );
  if (!couple) throw new AppError(404, 'NO_COUPLE', 'You are not in a couple room');
  return couple;
}

async function createInvitation(user) {
  assertVerified(user);
  const couple = await Couple.findOne({ _id: user.coupleId, members: user._id, status: 'pending' });
  if (!couple) throw new AppError(409, 'CANNOT_INVITE', 'Create a room first (or your room is already complete)');
  await Invitation.updateMany(
    { coupleId: couple._id, status: { $in: ['pending', 'accepted'] }, expiresAt: { $lt: now() } },
    { $set: { status: 'expired', resolvedAt: now() } }
  );
  if ((await Invitation.countDocuments({ inviterId: user._id, createdAt: { $gt: new Date(Date.now() - 86400000) } })) >= MAX_INVITES_PER_DAY) {
    throw new AppError(429, 'TOO_MANY_INVITES', 'You have created many invitations today. Try again tomorrow.');
  }
  const open = await Invitation.countDocuments({ coupleId: couple._id, status: { $in: ['pending', 'accepted'] } });
  if (open >= MAX_OPEN_INVITES) throw new AppError(429, 'TOO_MANY_INVITES', 'Revoke an existing invitation first');

  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + config.INVITATION_TTL_HOURS * 3600000);
  const inv = await Invitation.create({
    coupleId: couple._id,
    inviterId: user._id,
    codeHash: hashInviteCode(code),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + 30 * 86400000),
  });
  return { invitation: inv, code }; // plaintext code is returned exactly once
}

async function listInvitations(user) {
  return Invitation.find({ coupleId: user.coupleId, inviterId: user._id, status: { $in: ['pending', 'accepted'] } })
    .populate('inviteeId', 'username displayName')
    .sort({ createdAt: -1 });
}

async function acceptInvitation(user, rawCode) {
  assertVerified(user);
  if (user.coupleId) throw new AppError(409, 'ALREADY_IN_COUPLE', 'Leave your current room first');
  if (await Invitation.exists({ inviteeId: user._id, status: 'accepted' })) {
    throw new AppError(409, 'ALREADY_PENDING', 'You already have an invitation awaiting confirmation');
  }
  // A blocked person (either direction) gets the same generic answer as a wrong code: no hint that a block exists.
  const pre = await Invitation.findOne({ codeHash: hashInviteCode(rawCode), status: 'pending' }).select('inviterId');
  if (pre && (await safety.isBlockedEitherWay(user._id, pre.inviterId))) throw new AppError(404, 'INVALID_INVITATION', 'Invitation code is invalid or expired');
  const inv = await Invitation.findOneAndUpdate(
    { codeHash: hashInviteCode(rawCode), status: 'pending', expiresAt: { $gt: now() }, inviterId: { $ne: user._id } },
    { $set: { status: 'accepted', inviteeId: user._id, acceptedAt: now() } },
    { new: true }
  );
  // One generic error for wrong / used / expired / own code: no oracle for attackers.
  if (!inv) throw new AppError(404, 'INVALID_INVITATION', 'Invitation code is invalid or expired');
  return inv;
}

async function myAcceptedInvitations(user) {
  return Invitation.find({ inviteeId: user._id, status: 'accepted' }).select('status acceptedAt expiresAt');
}

async function confirmInvitation(user, invitationId) {
  const inv = await Invitation.findOneAndUpdate(
    { _id: invitationId, inviterId: user._id, status: 'accepted', expiresAt: { $gt: now() } },
    { $set: { status: 'confirmed', resolvedAt: now() } },
    { new: true }
  );
  if (!inv) throw new AppError(404, 'INVITATION_NOT_FOUND', 'No such invitation awaiting confirmation');

  const fail = async (status, code, msg) => {
    await Invitation.updateOne({ _id: inv._id }, { $set: { status, resolvedAt: now() } });
    throw new AppError(409, code, msg);
  };

  if (await safety.isBlockedEitherWay(inv.inviterId, inv.inviteeId)) await fail('rejected', 'INVITEE_UNAVAILABLE', 'That person can no longer join');

  // 1) Attach the invitee, only if they are still free and active.
  const attach = await User.updateOne(
    { _id: inv.inviteeId, coupleId: null, status: 'active' },
    { $set: { coupleId: inv.coupleId } }
  );
  if (attach.modifiedCount !== 1) await fail('rejected', 'INVITEE_UNAVAILABLE', 'That person can no longer join');

  // 2) Add them to the couple, only if it is still the pending 1-member room of the inviter.
  const upd = await Couple.updateOne(
    { $and: [{ _id: inv.coupleId }, { status: 'pending' }, { members: inv.inviterId }, { members: { $size: 1 } }] },
    { $push: { members: inv.inviteeId }, $set: { status: 'active', activatedAt: now(), keyVersion: 1 } }
  );
  if (upd.modifiedCount !== 1) {
    await User.updateOne({ _id: inv.inviteeId, coupleId: inv.coupleId }, { $unset: { coupleId: 1 } });
    await fail('revoked', 'COUPLE_UNAVAILABLE', 'This room can no longer accept a partner');
  }
  // 3) Any other open invitations for this room are now meaningless.
  await Invitation.updateMany(
    { coupleId: inv.coupleId, status: { $in: ['pending', 'accepted'] } },
    { $set: { status: 'revoked', resolvedAt: now() } }
  );
  return Couple.findById(inv.coupleId).populate('members', 'username displayName');
}

async function resolveInvitation(user, invitationId, from, to) {
  const inv = await Invitation.findOneAndUpdate(
    { _id: invitationId, inviterId: user._id, status: { $in: from } },
    { $set: { status: to, resolvedAt: now() } },
    { new: true }
  );
  if (!inv) throw new AppError(404, 'INVITATION_NOT_FOUND', 'No such open invitation');
  return inv;
}
const rejectInvitation = (u, id) => resolveInvitation(u, id, ['accepted'], 'rejected');
const revokeInvitation = (u, id) => resolveInvitation(u, id, ['pending', 'accepted'], 'revoked');

// Either partner can end the relationship. Messages/media are NOT deleted here; Phase 6 adds
// the retention job (see README "Data retention") that purges closed-room content.
async function leaveCouple(user) {
  const couple = await Couple.findOneAndUpdate(
    { _id: user.coupleId, members: user._id, status: { $in: ['pending', 'active'] } },
    { $set: { status: 'closed', closedAt: now(), closedBy: user._id } },
    { new: true }
  );
  if (!couple) throw new AppError(404, 'NO_COUPLE', 'You are not in a couple room');
  await User.updateMany({ _id: { $in: couple.members } }, { $unset: { coupleId: 1 } });
  await Invitation.updateMany(
    { coupleId: couple._id, status: { $in: ['pending', 'accepted'] } },
    { $set: { status: 'revoked', resolvedAt: now() } }
  );
  return couple;
}

module.exports = {
  getMyCouple, createCouple, updateCouple, createInvitation, listInvitations, acceptInvitation,
  myAcceptedInvitations, confirmInvitation, rejectInvitation, revokeInvitation, leaveCouple,
};
