const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const r = require('../src/calls/rules');

test('only legal call transitions are allowed', () => {
  for (const to of ['answered', 'missed', 'rejected', 'canceled']) assert.equal(r.canTransition('ringing', to), true, to);
  for (const to of ['ended', 'failed']) assert.equal(r.canTransition('answered', to), true, to);
  assert.equal(r.canTransition('ringing', 'ended'), false); // cannot "end" a call that never connected
  assert.equal(r.canTransition('answered', 'ringing'), false);
  assert.equal(r.canTransition('answered', 'rejected'), false);
  for (const done of ['ended', 'missed', 'rejected', 'canceled', 'failed']) for (const to of ['answered', 'ended', 'ringing']) assert.equal(r.canTransition(done, to), false, `${done}->${to}`);
  assert.equal(r.canTransition('nonsense', 'ended'), false);
  assert.equal(r.canTransition(undefined, 'ended'), false);
  assert.deepEqual([r.isActive('ringing'), r.isActive('answered'), r.isActive('ended'), r.isActive('missed')], [true, true, false, false]);
});

test('call duration counts from answer to end and never goes negative', () => {
  assert.equal(r.durationSec(new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:01:05Z')), 65);
  assert.equal(r.durationSec(new Date('2026-01-01T10:00:00.400Z'), new Date('2026-01-01T10:00:00.900Z')), 1);
  assert.equal(r.durationSec(new Date('2026-01-01T10:05:00Z'), new Date('2026-01-01T10:00:00Z')), 0);
  assert.equal(r.durationSec(null, new Date()), 0);
  assert.equal(r.durationSec(new Date(), undefined), 0);
});

test('TURN credentials: expiring username, HMAC-SHA1 password, deterministic', () => {
  const c = r.turnCredentials({ secret: 's3cret', userId: 'u1', nowMs: 1_700_000_000_000, ttlSec: 3600 });
  assert.equal(c.username, `${1_700_000_000 + 3600}:u1`);
  assert.equal(c.credential, crypto.createHmac('sha1', 's3cret').update(c.username).digest('base64'));
  assert.equal(c.ttlSec, 3600);
  const again = r.turnCredentials({ secret: 's3cret', userId: 'u1', nowMs: 1_700_000_000_000, ttlSec: 3600 });
  assert.deepEqual(again, c);
  assert.notEqual(r.turnCredentials({ secret: 'other', userId: 'u1', nowMs: 1_700_000_000_000 }).credential, c.credential);
  assert.notEqual(r.turnCredentials({ secret: 's3cret', userId: 'u2', nowMs: 1_700_000_000_000 }).credential, c.credential);
  // the expiry is inside the signed username, so it cannot be extended without the secret
  const forged = c.username.replace(String(1_700_000_000 + 3600), String(1_800_000_000));
  assert.notEqual(crypto.createHmac('sha1', 's3cret').update(forged).digest('base64'), c.credential);
});

test('ICE servers: STUN always, TURN only when configured, lists are tidied', () => {
  const base = { userId: 'u1', nowMs: 1_700_000_000_000, ttlSec: 600 };
  assert.deepEqual(r.buildIceServers({ ...base, stunUrls: ' stun:a.example:3478 , ,stun:b.example:3478' }), [{ urls: ['stun:a.example:3478', 'stun:b.example:3478'] }]);
  assert.deepEqual(r.buildIceServers({ ...base, stunUrls: '', turnUrls: '', turnSecret: '' }), []);
  assert.equal(r.buildIceServers({ ...base, stunUrls: 'stun:a', turnUrls: 'turn:t.example:3478' }).length, 1); // URLs without a secret: no TURN entry
  const full = r.buildIceServers({ ...base, stunUrls: 'stun:a', turnUrls: 'turn:t.example:3478,turns:t.example:5349', turnSecret: 'k' });
  assert.equal(full.length, 2);
  assert.deepEqual(full[1].urls, ['turn:t.example:3478', 'turns:t.example:5349']);
  assert.match(full[1].username, /^\d+:u1$/);
  assert.ok(full[1].credential.length > 10);
  assert.equal(JSON.stringify(full).includes('"k"'), false); // the shared secret itself never leaves the server
});

test('timing constants are sane', () => {
  assert.ok(r.RING_TIMEOUT_MS < r.STALE_RINGING_MS);
  assert.ok(r.OFFLINE_GRACE_MS < r.RING_TIMEOUT_MS);
  assert.ok(r.STALE_ANSWERED_MS > 3600_000);
});
