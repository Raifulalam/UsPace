'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setToken, tryRefresh } from './api';
import type { User } from './types';

type Status = 'loading' | 'anon' | 'authed';
type RegisterInput = { username: string; email: string; password: string; birthDate: string; displayName?: string; termsAccepted: true; privacyAccepted: true };
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
    const handleAuthLost = () => {
      if (alive) { setToken(null); setUser(null); setStatus('anon'); }
    };
    window.addEventListener('couples-auth-lost', handleAuthLost);
    const bootstrap = async () => {
      let user = await tryRefresh();
      if (!user) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        user = await tryRefresh();
      }
      if (alive) { setUser(user); setStatus(user ? 'authed' : 'anon'); }
    };
    void bootstrap();
    return () => { alive = false; window.removeEventListener('couples-auth-lost', handleAuthLost); };
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
