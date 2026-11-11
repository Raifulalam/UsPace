import type { User } from './types';

const inferredApiBase = typeof window !== 'undefined'
  ? `${window.location.protocol}//${window.location.hostname}:4000`
  : 'http://localhost:4000';
const configuredApiBase = process.env.NEXT_PUBLIC_API_URL;
export const API_BASE = typeof window !== 'undefined' &&
  window.location.hostname !== 'localhost' &&
  window.location.hostname !== '127.0.0.1'
  ? inferredApiBase
  : configuredApiBase ?? inferredApiBase;

// The access token lives ONLY in memory (never localStorage). The refresh token is an httpOnly cookie.
let accessToken: string | null = null;
export const setToken = (t: string | null) => { accessToken = t; };
export const getToken = () => accessToken;

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Query = Record<string, string | number | null | undefined>;
type Opts = { method?: string; body?: unknown; query?: Query };

// Single-flight: refresh tokens rotate and are single-use, so concurrent refreshes would trip reuse detection.
let refreshing: Promise<User | null> | null = null;
const notifyAuthLost = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('couples-auth-lost'));
};
export function tryRefresh(): Promise<User | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' });
        if (!res.ok) {
          if (res.status === 401) setToken(null);
          return null;
        }
        const j = await res.json();
        setToken(j.data.accessToken);
        return j.data.user as User;
      } catch {
        return null;
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

function send(path: string, o: Opts): Promise<Response> {
  const url = new URL(`${API_BASE}/api/v1${path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v != null) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(url, { method: o.method ?? 'GET', credentials: 'include', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
}

export async function api<T = unknown>(path: string, o: Opts = {}): Promise<T> {
  if (!accessToken && !path.startsWith('/auth/')) await tryRefresh();
  let res = await send(path, o);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await tryRefresh()) res = await send(path, o);
    else notifyAuthLost();
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Request failed', e?.details);
  }
  return json.data as T;
}
