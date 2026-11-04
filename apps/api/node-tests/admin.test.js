// Plain Node tests (no database): npm run test:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../src/admin/totp');
const perms = require('../src/admin/permissions');
const chain = require('../src/admin/auditChain');
const box = require('../src/admin/secretBox');

// ---- TOTP: RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890"; 6-digit = last 6 of the 8-digit values) ----
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
test('base32 round-trips and matches the RFC secret encoding', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(totp.base32Decode(RFC_SECRET), Buffer.from('12345678901234567890'));
  assert.deepEqual(totp.base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq'), Buffer.from('12345678901234567890'));
  assert.throws(() => totp.base32Decode('not*base32'));
  const r = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(totp.base32Decode(totp.base32Encode(r)), r);
});
test('TOTP matches the RFC 6238 vectors', () => {
  for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(totp.totp(RFC_SECRET, t * 1000), code, `t=${t}`);
  }
});
test('verifyTotp accepts +-1 step, refuses further, refuses replay, refuses malformed codes', () => {
  const t = 1111111109 * 1000;
  const now = totp.stepAt(t);
  assert.equal(totp.verifyTotp(RFC_SECRET, '081804', { timeMs: t }), now);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, t - 30000), { timeMs: t }), now - 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, t + 30000), { timeMs: t }), now + 1);
  assert.equal(totp.verifyTotp(RFC_SECRET, totp.totp(RFC_SECRET, t + 90000), { timeMs: t }), null);
  assert.equal(totp.verifyTotp(RFC_SECRET, '081804', { timeMs: t, lastUsedStep: now }), null); // replay of the same code
  assert.equal(totp.verifyTotp(RFC_SECRET, '081804', { timeMs: t, lastUsedStep: now - 1 }), now);
  for (const bad of ['', '12345', '1234567', 'abcdef', '08180 4', 081804, null, undefined]) assert.equal(totp.verifyTotp(RFC_SECRET, bad, { timeMs: t }), null);
});
test('secrets and recovery codes look right and normalise', () => {
  assert.match(totp.generateSecret(), /^[A-Z2-7]{32}$/);
  assert.notEqual(totp.generateSecret(), totp.generateSecret());
  const codes = totp.generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(totp.hashRecovery(codes[0]), totp.hashRecovery(codes[0].toLowerCase().replace('-', ' ')));
  assert.notEqual(totp.hashRecovery(codes[0]), totp.hashRecovery(codes[1]));
  assert.match(totp.otpauthUri({ secret: 'ABC', account: 'a@b.co', issuer: 'Our Space' }), /^otpauth:\/\/totp\/Our%20Space:a%40b\.co\?secret=ABC&issuer=Our%20Space/);
});

// ---- permissions ----
test('roles get only what they need; unknown roles and permissions are denied', () => {
  for (const p of perms.ALL_PERMISSIONS) assert.equal(perms.can('superadmin', p), true, p);
  assert.equal(perms.can('moderator', 'users:suspend'), true);
  assert.equal(perms.can('moderator', 'settings:write'), false);
  assert.equal(perms.can('moderator', 'audit:read'), false);
  assert.equal(perms.can('moderator', 'users:read-email'), false);
  assert.equal(perms.can('support', 'users:read'), true);
  assert.equal(perms.can('support', 'users:suspend'), false);
  assert.equal(perms.can('support', 'reports:handle'), false);
  assert.equal(perms.can('admins:manage', 'users:read'), false);
  assert.equal(perms.can('superadmin', 'read-private-messages'), false); // no such permission exists, even for the owner
  assert.equal(perms.can(undefined, 'stats:read'), false);
  assert.ok(!perms.ALL_PERMISSIONS.some((p) => /message|memor|media|canvas|drawing|location|call/.test(p)));
});
test('maskEmail hides most of the address', () => {
  assert.equal(perms.maskEmail('alice@example.com'), 'a***@e***.com');
  assert.equal(perms.maskEmail('bob@mail.co.uk'), 'b***@m***.uk');
  assert.equal(perms.maskEmail('weird'), '***@***');
});

// ---- audit chain ----
function build(n) {
  const out = [];
  let prev = chain.GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const e = { seq, adminId: 'a1', adminEmail: 'root@x.co', action: seq % 2 ? 'users.suspend' : 'settings.update', targetType: 'user', targetId: `u${seq}`, details: { reason: 'spam', n: seq, nested: { b: 1, a: [1, 2] } }, ip: '10.0.0.1', at: `2026-01-0${(seq % 9) + 1}T00:00:00.000Z` };
    e.prevHash = prev; e.hash = chain.entryHash(prev, e); prev = e.hash;
    out.push(e);
  }
  return out;
}
test('an intact chain verifies; key order inside details does not matter', () => {
  const log = build(6);
  assert.deepEqual(chain.verifyChain(log), { ok: true, count: 6, head: log[5].hash });
  assert.deepEqual(chain.verifyChain([]), { ok: true, count: 0, head: chain.GENESIS });
  const shuffled = JSON.parse(JSON.stringify(log));
  shuffled[2].details = { nested: { a: [1, 2], b: 1 }, n: 3, reason: 'spam' };
  assert.equal(chain.verifyChain(shuffled).ok, true);
});
test('editing, deleting, inserting or reordering is detected', () => {
  const edit = build(5); edit[2].details.reason = 'nothing happened';
  assert.deepEqual(chain.verifyChain(edit), { ok: false, brokenAt: 3, reason: 'entry content was altered' });
  const whoDidIt = build(5); whoDidIt[3].adminEmail = 'someone@else.co';
  assert.equal(chain.verifyChain(whoDidIt).brokenAt, 4);
  const del = build(5); del.splice(2, 1);
  assert.equal(chain.verifyChain(del).ok, false);
  assert.match(chain.verifyChain(del).reason, /missing/);
  const tail = build(5).slice(0, 3);
  assert.equal(chain.verifyChain(tail).ok, true); // truncating the END is caught by comparing the stored head/count, see the audit service
  const reorder = build(4); [reorder[1], reorder[2]] = [reorder[2], reorder[1]];
  assert.equal(chain.verifyChain(reorder).ok, false);
  const relink = build(4); relink[1].prevHash = 'f'.repeat(64);
  assert.equal(chain.verifyChain(relink).ok, false);
});

// ---- secret box ----
test('secretBox round-trips, and tampering or a wrong key fails', () => {
  const sealed = box.seal('JBSWY3DPEHPK3PXP', 'k'.repeat(40));
  assert.equal(box.open(sealed, 'k'.repeat(40)), 'JBSWY3DPEHPK3PXP');
  assert.notEqual(box.seal('x', 'k'.repeat(40)), box.seal('x', 'k'.repeat(40))); // fresh IV every time
  assert.throws(() => box.open(sealed, 'z'.repeat(40)));
  const [v, iv, tag, ct] = sealed.split('.');
  assert.throws(() => box.open([v, iv, tag, ct.slice(0, -2) + 'AA'].join('.'), 'k'.repeat(40)));
  assert.throws(() => box.open('garbage', 'k'.repeat(40)));
  assert.ok(!sealed.includes('JBSWY3DPEHPK3PXP'));
});
