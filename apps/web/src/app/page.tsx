'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/session';

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === 'authed') router.replace('/space');
    if (status === 'anon') router.replace('/login');
  }, [status, router]);
  return <main className="grid min-h-screen place-items-center text-muted">Loading…</main>;
}
