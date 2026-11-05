'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setToken, tryRefresh } from './api';
import type { User } from './types';

type Status = 'loading' | 'anon' | 'authed';
type RegisterInput = { username: string; email: string; password: string; birthDate: string; displayName?: string };
type Ctx = {
  user: User | null; status: Status;
  login: (identifier: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (u: User) => void;
};
const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let alive = true;
    tryRefresh().then((u) => { if (alive) { setUser(u); setStatus(u ? 'authed' : 'anon'); } });
    return () => { alive = false; };
  }, []);

  const finish = useCallback((r: { user: User; accessToken: string }) => { setToken(r.accessToken); setUser(r.user); setStatus('authed'); }, []);
  const value = useMemo<Ctx>(() => ({
    user, status,
    login: async (identifier, password) => finish(await api('/auth/login', { method: 'POST', body: { identifier, password } })),
    register: async (input) => finish(await api('/auth/register', { method: 'POST', body: input })),
    updateUser: (u) => setUser(u),
    logout: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); setUser(null); setStatus('anon'); },
  }), [user, status, finish]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
