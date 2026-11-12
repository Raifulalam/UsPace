const admin = require('firebase-admin');
const config = require('../config/env');
const PushToken = require('../models/PushToken');
const Couple = require('../models/Couple');

const configured = Boolean(config.FIREBASE_PROJECT_ID && config.FIREBASE_CLIENT_EMAIL && config.FIREBASE_PRIVATE_KEY);
let messaging = null;

if (configured) {
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.FIREBASE_PROJECT_ID,
        clientEmail: config.FIREBASE_CLIENT_EMAIL,
        privateKey: config.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  messaging = admin.messaging(app);
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

async function notifyNewMessage({ coupleId, senderId, messageId }) {
  if (!messaging) return { configured: false, sent: 0 };
  const couple = await Couple.findById(coupleId).select('members');
  if (!couple) return { configured: true, sent: 0 };
  const recipientIds = couple.members.filter((id) => String(id) !== String(senderId));
  const tokens = await PushToken.find({ userId: { $in: recipientIds }, platform: 'android' }).select('_id token').sort({ createdAt: 1 });
  if (!tokens.length) return { configured: true, sent: 0 };

  const response = await messaging.sendEachForMulticast({
    tokens: tokens.map((t) => t.token),
    android: { priority: 'high' },
    data: { type: 'new_message', coupleId: String(coupleId), messageId: String(messageId) },
  });
  const invalidIds = response.responses
    .map((result, index) => result.success || !INVALID_TOKEN_CODES.has(result.error?.code) ? null : tokens[index]._id)
    .filter(Boolean);
  if (invalidIds.length) await PushToken.deleteMany({ _id: { $in: invalidIds } });
  return { configured: true, sent: response.successCount, removed: invalidIds.length };
}

module.exports = { notifyNewMessage, isConfigured: () => configured };
