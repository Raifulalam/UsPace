const c = require('../src');

beforeAll(() => c.ready());
const aad = { coupleId: 'c1', senderId: 'u1', clientMsgId: 'm1', keyVersion: 1, kind: 'text' };

test('payload round-trips and ciphertext hides length within a block', () => {
  const key = c.generateRoomKey();
  const a = c.encryptPayload(key, { text: 'hi' }, aad);
  const b = c.encryptPayload(key, { text: 'hello there!' }, aad);
  expect(a.ciphertext.length).toBe(b.ciphertext.length);
  expect(c.decryptPayload(key, a, aad)).toEqual({ text: 'hi' });
});

test('tampering or changing any bound field makes decryption fail', () => {
  const key = c.generateRoomKey();
  const enc = c.encryptPayload(key, { text: 'secret' }, aad);
  for (const patch of [{ coupleId: 'c2' }, { senderId: 'u2' }, { clientMsgId: 'm2' }, { keyVersion: 2 }, { kind: 'media' }]) {
    expect(() => c.decryptPayload(key, enc, { ...aad, ...patch })).toThrow();
  }
  const flipped = { ...enc, ciphertext: (enc.ciphertext[0] === 'A' ? 'B' : 'A') + enc.ciphertext.slice(1) };
  expect(() => c.decryptPayload(key, flipped, aad)).toThrow();
  expect(() => c.decryptPayload(c.generateRoomKey(), enc, aad)).toThrow();
});

test('room key wraps to a device and only that device can open it', () => {
  const alice = c.generateDeviceKeyPair();
  const bob = c.generateDeviceKeyPair();
  const eve = c.generateDeviceKeyPair();
  const roomKey = c.generateRoomKey();
  const env = c.wrapRoomKey(roomKey, bob.publicKey, alice.secretKey);
  expect(Buffer.from(c.unwrapRoomKey(env, alice.publicKey, bob.secretKey))).toEqual(Buffer.from(roomKey));
  expect(() => c.unwrapRoomKey(env, alice.publicKey, eve.secretKey)).toThrow();
  expect(() => c.unwrapRoomKey(env, eve.publicKey, bob.secretKey)).toThrow(); // wrong claimed sender
});

test('safety number is order independent and changes when a key changes', () => {
  const [a, b, d] = [1, 2, 3].map(() => c.generateDeviceKeyPair().publicKey);
  expect(c.safetyNumber([a, b])).toBe(c.safetyNumber([b, a]));
  expect(c.safetyNumber([a, b])).not.toBe(c.safetyNumber([a, d]));
  expect(c.safetyNumber([a, b])).toMatch(/^(\d{5} ){5}\d{5}$/);
});

test('recovery key formats, parses and restores room keys; wrong key or user fails', () => {
  const rk = c.generateRecoveryKey();
  const text = c.formatRecoveryKey(rk);
  expect(text).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  expect(Buffer.from(c.parseRecoveryKey(text.toLowerCase()))).toEqual(Buffer.from(rk));
  const room1 = c.generateRoomKey();
  const room2 = c.generateRoomKey();
  const blob = c.createRecoveryBlob(rk, { 1: room1, 2: room2 }, 'u1');
  const opened = c.openRecoveryBlob(c.parseRecoveryKey(text), blob, 'u1');
  expect(Buffer.from(opened[2])).toEqual(Buffer.from(room2));
  expect(() => c.openRecoveryBlob(c.generateRecoveryKey(), blob, 'u1')).toThrow();
  expect(() => c.openRecoveryBlob(rk, blob, 'someone-else')).toThrow();
  expect(() => c.parseRecoveryKey('too-short')).toThrow();
});

test('padding is reversible', () => {
  const { pad, unpad } = c._internal;
  for (const n of [0, 1, 127, 128, 129, 1000]) {
    const x = Uint8Array.from({ length: n }, (_, i) => (i % 250) + 1);
    expect(Buffer.from(unpad(pad(x)))).toEqual(Buffer.from(x));
  }
});

test('encryptRaw/decryptRaw bind to the AAD string', () => {
  const key = c.generateRoomKey();
  const enc = c.encryptRaw(key, { t: 'stroke', pts: [1, 2] }, 'ctx|canvas1|alice|op1|1');
  expect(c.decryptRaw(key, enc, 'ctx|canvas1|alice|op1|1')).toEqual({ t: 'stroke', pts: [1, 2] });
  expect(() => c.decryptRaw(key, enc, 'ctx|canvas2|alice|op1|1')).toThrow();
  expect(() => c.decryptRaw(key, enc, 'ctx|canvas1|bob|op1|1')).toThrow();
});

describe('file encryption', () => {
  const CH = 16; // tiny chunk so multi-chunk paths run fast
  const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  const sample = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);
  const expectedSize = (n) => 24 + n + 17 * Math.max(1, Math.ceil(n / CH));

  test.each([0, 1, 15, 16, 17, 32, 100])('round-trips %i bytes and matches the size formula', (n) => {
    const key = c.generateFileKey();
    const data = sample(n);
    const enc = concat(c.encryptFile(key, data, CH));
    expect(enc.length).toBe(expectedSize(n));
    expect(concat(c.decryptFile(key, new Uint8Array(enc), CH))).toEqual(Buffer.from(data));
  });

  test('the default chunk size matches the shared constant (1 MiB)', () => {
    expect(c.FILE_CHUNK).toBe(1 << 20);
  });

  test('wrong key, flipped bit, truncation, extra bytes and reordering all fail', () => {
    const key = c.generateFileKey();
    const enc = new Uint8Array(concat(c.encryptFile(key, sample(50), CH)));
    expect(() => c.decryptFile(c.generateFileKey(), enc, CH)).toThrow();
    const flipped = enc.slice(); flipped[40] ^= 1;
    expect(() => c.decryptFile(key, flipped, CH)).toThrow();
    expect(() => c.decryptFile(key, enc.slice(0, enc.length - (CH + 17)), CH)).toThrow(); // dropped final chunk
    expect(() => c.decryptFile(key, enc.slice(0, enc.length - 3), CH)).toThrow();
    expect(() => c.decryptFile(key, Uint8Array.from([...enc, 0]), CH)).toThrow();
    const step = CH + 17;
    const swapped = Uint8Array.from([...enc.slice(0, 24), ...enc.slice(24 + step, 24 + 2 * step), ...enc.slice(24, 24 + step), ...enc.slice(24 + 2 * step)]);
    expect(() => c.decryptFile(key, swapped, CH)).toThrow();
    expect(() => c.decryptFile(key, new Uint8Array(10), CH)).toThrow();
  });

  test('file keys are 32 bytes in the canonical base64 shape the descriptor validator expects', () => {
    expect(c.toBase64(c.generateFileKey())).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
