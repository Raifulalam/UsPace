declare module '@couples/space-core' {
  export type Anniversary = { upcoming: boolean; daysTogether: number; daysToNext: number; years: number; isToday: boolean; nextDate: string };
  export const DAY: number;
  export function anniversaryInfo(dateStr: string, todayMs?: number): Anniversary | null;
  export function localTodayMs(d?: Date): number;
  export function initialsOf(name: string): string;
  export function hueOf(str: string): number;
  export function formatRelative(thenMs: number, nowMs?: number): string;
  export function dayKey(iso: string, offsetMinutes?: number): string;
  export function groupByDay<T>(items: T[], getIso: (x: T) => string, offsetMinutes?: number): { key: string; items: T[] }[];
  export const TTL_OPTIONS: readonly { sec: number; label: string }[];
  export const ALLOWED_TTL: readonly number[];
  export const REACTIONS: readonly string[];
  export const STICKERS: readonly string[];
  export function validateReaction(p: unknown): string | null;
  export function validateSticker(p: unknown): string | null;
  export function validateReplyTo(v: unknown): string | null;
  export function formatDuration(sec: number): string;
  export function validateCallSignal(p: unknown): { t: 'offer' | 'answer'; sdp: string } | { t: 'ice'; candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } } | null;
  export function lastSeenMessageId(messages: { id: string | null; senderId: string }[], partnerLastReadId: string | null, myId: string): string | null;
}
