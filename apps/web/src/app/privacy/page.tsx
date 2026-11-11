import Link from 'next/link';

export default function PrivacyPage() {
  return <main className="mx-auto max-w-3xl px-5 py-10">
    <Link href="/register" className="text-accent2 underline">Back to registration</Link>
    <article className="card mt-6 space-y-5">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>
      <p>We process account details, authentication records, device public keys, encrypted content, and limited routing metadata to provide Our Space.</p>
      <h2 className="text-xl font-semibold">Encryption</h2>
      <p>Private messages, canvas operations, and supported media are encrypted on approved devices. The server stores ciphertext and necessary metadata; it does not receive room private keys.</p>
      <h2 className="text-xl font-semibold">Your controls</h2>
      <p>You can manage devices, sessions, notifications, content, and account deletion from Settings. Removing a device rotates room keys. We retain security and audit records where needed to protect the service or comply with law.</p>
      <p className="text-sm text-muted">Last updated: November 11, 2026.</p>
    </article>
  </main>;
}
