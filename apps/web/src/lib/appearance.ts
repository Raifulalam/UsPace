'use client';
import { useCallback, useEffect, useState } from 'react';

export type Mode = 'auto' | 'light' | 'dark';
const KEY = 'couples:mode';
const read = (): Mode => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch { return 'auto'; } };

/** Applies the room theme and the light/dark choice to the page. Storage is a convenience only: everything works if it is unavailable. */
export function useAppearance(theme: string | undefined) {
  const [mode, setMode] = useState<Mode>('auto');
  useEffect(() => { setMode(read()); }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (mode === 'auto') delete el.dataset.mode; else el.dataset.mode = mode;
    if (theme && theme !== 'rose') el.dataset.theme = theme; else delete el.dataset.theme;
  }, [mode, theme]);
  const cycle = useCallback(() => {
    setMode((m) => { const next: Mode = m === 'auto' ? 'light' : m === 'light' ? 'dark' : 'auto'; try { localStorage.setItem(KEY, next); } catch { /* ignore */ } return next; });
  }, []);
  return { mode, cycle };
}
