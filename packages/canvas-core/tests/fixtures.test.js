// The SAME cases are run by the Android app's Kotlin tests, so both ports must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src');
const fx = require('../fixtures/cases.json');

for (const k of fx.scene) {
  test(`scene: ${k.name}`, () => {
    const entries = k.entries.map((e) => ({ ...e, op: c.validateOp(e.op) }));
    assert.ok(entries.every((e) => e.op), 'fixture ops must be valid');
    const s = c.computeScene(entries);
    assert.deepEqual(s.visible.map((d) => d.op.id), k.visible);
    assert.deepEqual(s.hidden.map((d) => d.op.id), k.hidden);
    assert.deepEqual(s.bg, k.bg);
  });
}
for (const k of fx.validate) {
  test(`validateOp: ${k.name}`, () => {
    const op = c.validateOp(k.op);
    assert.equal(op !== null, k.valid);
    if (k.expectPts) assert.deepEqual(op.pts, k.expectPts);
    if (k.expectSize) assert.equal(op.size, k.expectSize);
  });
}
for (const k of fx.validateLive) {
  test(`validateLive: ${k.name}`, () => assert.equal(c.validateLive(k.payload) !== null, k.valid));
}
