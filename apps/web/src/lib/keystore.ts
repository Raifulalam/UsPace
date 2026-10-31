import { createStore, get, set, del, type UseStore } from 'idb-keyval';

// Device secret key and room keys live in IndexedDB as base64 strings. They are readable by any script running
// on this origin, which is why XSS hardening (CSP) matters. See README.
export type LocalDevice = { id: string; publicKey: string; secretKey: string };

let store: UseStore | undefined;
const st = () => (store ??= createStore('couples-e2ee', 'kv'));

export const loadDevice = (userId: string) => get<LocalDevice>(`device:${userId}`, st());
export const saveDevice = (userId: string, d: LocalDevice) => set(`device:${userId}`, d, st());
export const loadRoomKeys = async (userId: string, coupleId: string) =>
  (await get<Record<string, string>>(`roomkeys:${userId}:${coupleId}`, st())) ?? {};
export const saveRoomKeys = (userId: string, coupleId: string, keys: Record<string, string>) =>
  set(`roomkeys:${userId}:${coupleId}`, keys, st());
export const forgetLocal = async (userId: string, coupleId?: string) => {
  await del(`device:${userId}`, st());
  if (coupleId) await del(`roomkeys:${userId}:${coupleId}`, st());
};
