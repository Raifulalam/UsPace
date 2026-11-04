export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const ROOT = `${API_BASE}/api/v1/admin`;

// The access token lives only in memory. The refresh token is an httpOnly SameSite=Strict cookie scoped to /api/v1/admin/auth.
let token: string | null = null;
export const setToken = (t: string | null) => { token = t; };

export class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const say = (e: unknown): string => {
  if (e instanceof ApiError) return Array.isArray(e.details) && e.details.length ? (e.details as { path: string; message: string }[]).map((d) => `${d.path}: ${d.message}`).join(' · ') : e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
};

type Opts = { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null>; auth?: boolean };
async function send(path: string, o: Opts): Promise<Response> {
  const url = new URL(`${ROOT}${path}`);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method: o.method ?? 'GET', credentials: 'include', headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
}
async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) { const e = json?.error; throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Request failed', e?.details); }
  return json.data as T;
}

export type Admin = { id: string; email: string; role: 'superadmin' | 'moderator' | 'support'; status: string; mfaEnabled: boolean };
export type Session = { admin: Admin; accessToken: string; recoveryCodes?: string[] };

// Refresh tokens rotate and are single-use: never refresh twice at once.
let refreshing: Promise<Session | null> | null = null;
export function tryRefresh(): Promise<Session | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await send('/auth/refresh', { method: 'POST', auth: false });
        if (!res.ok) { token = null; return null; }
        const s = await parse<Session>(res);
        token = s.accessToken;
        return s;
      } catch { return null; }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Calls for sign-in steps: no bearer token, no automatic refresh. */
export async function authCall<T>(path: string, body?: unknown): Promise<T> {
  return parse<T>(await send(path, { method: 'POST', body: body ?? {}, auth: false }));
}
export async function api<T = unknown>(path: string, o: Opts = {}): Promise<T> {
  let res = await send(path, o);
  if (res.status === 401 && (await tryRefresh())) res = await send(path, o);
  return parse<T>(res);
}
export const signOut = async () => { await send('/auth/logout', { method: 'POST', auth: false }).catch(() => {}); token = null; };
