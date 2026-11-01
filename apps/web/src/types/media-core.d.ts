declare module '@couples/media-core' {
  export type Thumb = { id: string; key: string; mime: 'image/jpeg'; w: number; h: number };
  export type Descriptor = { id: string; key: string; mime: string; size: number; name?: string; w?: number; h?: number; dur?: number; voice?: true; thumb?: Thumb };
  export type MemoryType = 'photo' | 'video' | 'voice' | 'drawing' | 'message' | 'note' | 'letter' | 'date';
  export type MemoryPayload = { v: 1; title?: string; caption?: string; text?: string; from?: string; sentAt?: number; media?: Descriptor[] };
  export const LIMITS: { image: number; video: number; audio: number; thumb: number };
  export const MEMORY_TYPES: readonly MemoryType[];
  export function kindForMime(mime: string): 'image' | 'video' | 'audio' | null;
  export function encryptedSize(plainLen: number, chunk?: number): number;
  export function formatBytes(n: number): string;
  export function sniffMime(bytes: Uint8Array, declared?: string): string | null;
  export function validateDescriptor(d: unknown): Descriptor | null;
  export function validateMemoryPayload(p: unknown, type: MemoryType): MemoryPayload | null;
  export function monthKey(iso: string): string;
  export function groupByMonth<T>(items: T[], getDate: (x: T) => string): { key: string; items: T[] }[];
  export function matchesQuery(parts: (string | undefined | null)[], query: string): boolean;
  export function mediaIdsOf(descriptors: Descriptor[] | undefined): string[];
  export function memoryTypeFor(d: { mime: string }): 'photo' | 'video' | 'voice' | null;
}
