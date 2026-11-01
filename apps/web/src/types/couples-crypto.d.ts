declare module '@couples/crypto' {
  type Enc = { nonce: string; ciphertext: string };
  export interface AadFields { coupleId: string; senderId: string; clientMsgId: string; keyVersion: number; kind: string }
  export function ready(): Promise<void>;
  export function toBase64(b: Uint8Array): string;
  export function fromBase64(s: string): Uint8Array;
  export function generateDeviceKeyPair(): { publicKey: string; secretKey: Uint8Array };
  export function generateRoomKey(): Uint8Array;
  export function wrapRoomKey(roomKey: Uint8Array, recipientPublicKeyB64: string, senderSecretKey: Uint8Array): Enc;
  export function unwrapRoomKey(envelope: Enc, senderPublicKeyB64: string, recipientSecretKey: Uint8Array): Uint8Array;
  export function encryptPayload(roomKey: Uint8Array, payload: unknown, aad: AadFields): Enc;
  export function decryptPayload(roomKey: Uint8Array, enc: Enc, aad: AadFields): any;
  export function encryptRaw(roomKey: Uint8Array, payload: unknown, aadString: string): Enc;
  export function decryptRaw(roomKey: Uint8Array, enc: Enc, aadString: string): any;
  export function generateFileKey(): Uint8Array;
  export function encryptFile(fileKey: Uint8Array, bytes: Uint8Array, chunk?: number): Uint8Array[];
  export function decryptFile(fileKey: Uint8Array, data: Uint8Array, chunk?: number): Uint8Array[];
  export function safetyNumber(publicKeysB64: string[]): string;
  export function generateRecoveryKey(): Uint8Array;
  export function formatRecoveryKey(key: Uint8Array): string;
  export function parseRecoveryKey(text: string): Uint8Array;
  export function createRecoveryBlob(recoveryKey: Uint8Array, roomKeys: Record<string, Uint8Array>, userId: string): { version: 1; nonce: string; ciphertext: string };
  export function openRecoveryBlob(recoveryKey: Uint8Array, blob: Enc, userId: string): Record<string, Uint8Array>;
}
