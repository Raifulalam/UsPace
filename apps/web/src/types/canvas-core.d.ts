declare module '@couples/canvas-core' {
  export const W: number;
  export const H: number;
  export const TOOLS: readonly ['pen', 'brush', 'eraser'];
  export const STICKERS: readonly ['heart', 'star', 'flower', 'arrow', 'spark'];
  export const PATTERNS: readonly ['none', 'dots', 'grid', 'lines', 'hearts'];
  export const DEFAULT_BG: Bg;
  export const MAX_STROKE_COORDS: number;
  export type Tool = 'pen' | 'brush' | 'eraser';
  export type Sticker = 'heart' | 'star' | 'flower' | 'arrow' | 'spark';
  export type Bg = { color: string; pattern: string };
  export type Op =
    | { t: 'stroke'; id: string; tool: Tool; color: string; size: number; pts: number[] }
    | { t: 'text'; id: string; text: string; x: number; y: number; color: string; size: number }
    | { t: 'sticker'; id: string; kind: Sticker; x: number; y: number; color: string; size: number; rot: number }
    | { t: 'undo'; target: string } | { t: 'redo'; target: string } | { t: 'clear' }
    | { t: 'bg'; color: string; pattern: string };
  export type Entry = { seq: number; senderId: string; op: Op };
  export type Scene = { visible: Entry[]; hidden: Entry[]; bg: Bg };
  export type Live =
    | { k: 'stroke'; sid: string; tool: Tool; color: string; size: number; pts: number[]; start: boolean }
    | { k: 'text'; sid: string; text: string; x: number; y: number; color: string; size: number };
  export function validateOp(op: unknown): Op | null;
  export function validateLive(p: unknown): Live | null;
  export function computeScene(entries: Entry[]): Scene;
  export function undoCandidate(scene: Scene, me: string): string | null;
  export function hiddenIdsBy(scene: Scene, me: string): string[];
}
