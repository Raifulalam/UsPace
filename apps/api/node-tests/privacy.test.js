const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/utils/privacy');

test('maskIp keeps the network and drops the host', () => {
  assert.equal(p.maskIp('203.0.113.77'), '203.0.113.x');
  assert.equal(p.maskIp('::ffff:198.51.100.9'), '198.51.100.x');
  assert.equal(p.maskIp('2001:db8:abcd:12::1'), '2001:db8:abcd:…');
  for (const bad of [undefined, null, '', 'not an ip', 42]) assert.equal(p.maskIp(bad), null);
});

test('describeAgent gives a friendly label and never echoes the raw header', () => {
  assert.equal(p.describeAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'Chrome on Windows');
  assert.equal(p.describeAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120'), 'Edge on Windows');
  assert.equal(p.describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari/604'), 'Safari on iOS');
  assert.equal(p.describeAgent('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537'), 'Chrome on Android');
  assert.equal(p.describeAgent('okhttp/4.12.0'), 'Android app');
  assert.equal(p.describeAgent(''), 'Unknown device');
  assert.equal(p.describeAgent('<script>alert(1)</script>'), 'Unknown device');
});

test('retention dates', () => {
  const now = Date.UTC(2026, 0, 31);
  assert.equal(p.deletionDate(now).getTime(), now + 14 * p.DAY);
  assert.equal(p.closedCoupleCutoff(now).getTime(), now - 30 * p.DAY);
});
