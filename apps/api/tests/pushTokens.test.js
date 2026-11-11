jest.mock('../src/services/pushNotificationService', () => ({
  notifyNewMessage: jest.fn().mockResolvedValue({ configured: false, sent: 0 }),
}));

const request = require('supertest');
const { createApp } = require('../src/app');
const PushToken = require('../src/models/PushToken');
const { startDb, stopDb, registerUser, authed } = require('./helpers');

const app = createApp();
beforeAll(startDb);
afterAll(stopDb);

describe('push token registration', () => {
  test('requires authentication and associates a token with an active Android device', async () => {
    const unauthenticated = await request(app).post('/api/v1/push-tokens').send({ token: 'fcm-token', deviceId: '000000000000000000000000' });
    expect(unauthenticated.status).toBe(401);

    const user = await registerUser(app);
    const U = authed(app, user);
    const device = (await U.post('/api/v1/devices', {
      publicKey: Buffer.alloc(32).toString('base64'),
      label: 'Android',
    })).body.data.device;

    const first = await U.post('/api/v1/push-tokens', { token: 'fcm-token', deviceId: device.id });
    expect(first.status).toBe(200);
    expect(first.body.data.pushToken).toMatchObject({ deviceId: device.id, platform: 'android' });

    const update = await U.post('/api/v1/push-tokens', { token: 'updated-fcm-token', deviceId: device.id });
    expect(update.status).toBe(200);
    expect(await PushToken.countDocuments({ userId: user.user.id })).toBe(1);
    expect(await PushToken.exists({ token: 'updated-fcm-token', deviceId: device.id })).toBeTruthy();

    expect((await U.del('/api/v1/push-tokens')).status).toBe(400);
    expect((await request(app).delete('/api/v1/push-tokens').set('Authorization', `Bearer ${user.token}`).send({ token: 'updated-fcm-token' })).status).toBe(204);
    expect(await PushToken.countDocuments({ userId: user.user.id })).toBe(0);
  });

  test('rejects a token registration for another user device', async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const ownerDevice = (await authed(app, owner).post('/api/v1/devices', {
      publicKey: Buffer.alloc(32, 1).toString('base64'),
      label: 'Android',
    })).body.data.device;

    const response = await authed(app, other).post('/api/v1/push-tokens', { token: 'wrong-device', deviceId: ownerDevice.id });
    expect(response.status).toBe(403);
  });
});
