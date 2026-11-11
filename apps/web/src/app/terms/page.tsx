import Link from 'next/link';

export default function TermsPage() {
  return <main className="mx-auto max-w-3xl px-5 py-10">
    <Link href="/register" className="text-accent2 underline">Back to registration</Link>
    <article className="card mt-6 space-y-5">
      <h1 className="text-3xl font-semibold">Terms of Service</h1>
      <p>By using Our Space, you agree to use the service lawfully and respectfully, keep your account secure, and provide accurate information.</p>
      <h2 className="text-xl font-semibold">Private content</h2>
      <p>Our Space is designed for two people. Do not upload content you do not have permission to share. End-to-end encrypted content cannot be recovered if you lose all approved devices and recovery material.</p>
      <h2 className="text-xl font-semibold">Availability and safety</h2>
      <p>The service may change or be unavailable. Do not rely on it for emergencies or safety-critical communication. We may suspend accounts or rooms for abuse, security, or legal reasons.</p>
      <p className="text-sm text-muted">Last updated: November 11, 2026.</p>
    </article>
  </main>;
}
