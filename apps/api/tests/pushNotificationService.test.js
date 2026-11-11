process.env.FIREBASE_PROJECT_ID = 'test-project';
process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@test-project.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n';

const mockSendEachForMulticast = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [],
  app: jest.fn(),
  initializeApp: jest.fn(() => ({})),
  credential: { cert: jest.fn() },
  messaging: jest.fn(() => ({ sendEachForMulticast: mockSendEachForMulticast })),
}));

const mongoose = require('mongoose');
const Couple = require('../src/models/Couple');
const PushToken = require('../src/models/PushToken');
const { notifyNewMessage } = require('../src/services/pushNotificationService');
const { startDb, stopDb } = require('./helpers');

beforeAll(startDb);
afterAll(stopDb);
afterAll(() => {
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
});

test('delivers generic notification data and removes invalid FCM tokens', async () => {
  const senderId = new mongoose.Types.ObjectId();
  const recipientId = new mongoose.Types.ObjectId();
  const coupleId = new mongoose.Types.ObjectId();
  await Couple.create({ _id: coupleId, members: [senderId, recipientId], createdBy: senderId, status: 'active' });
  const valid = await PushToken.create({ userId: recipientId, deviceId: new mongoose.Types.ObjectId(), token: 'valid-token' });
  const invalid = await PushToken.create({ userId: recipientId, deviceId: new mongoose.Types.ObjectId(), token: 'expired-token' });
  mockSendEachForMulticast.mockImplementationOnce(({ tokens }) => Promise.resolve({
    successCount: 1,
    responses: tokens.map((token) => token === 'expired-token'
      ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
      : { success: true }),
  }));

  await notifyNewMessage({ coupleId, senderId, messageId: new mongoose.Types.ObjectId() });

  const payload = mockSendEachForMulticast.mock.calls[0][0];
  expect(payload.notification.body).toBe('You have a new message');
  expect(payload.data).toMatchObject({ type: 'new_message', coupleId: String(coupleId) });
  expect(payload.data).not.toHaveProperty('ciphertext');
  expect(await PushToken.exists({ _id: valid._id })).toBeTruthy();
  expect(await PushToken.exists({ _id: invalid._id })).toBeFalsy();
});
