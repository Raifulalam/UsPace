'use client';
import { useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';

export default function RecoveryKeyDialog({ text, onDone }: { text: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="rk-h" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="card grid max-w-md gap-3">
        <h2 id="rk-h" className="flex items-center gap-2 text-lg font-semibold"><KeyRound className="h-5 w-5 text-accent2" aria-hidden />Your recovery key</h2>
        <p className="text-sm text-muted">If you lose all your devices, this key is the <strong>only</strong> way to read your history again. We can’t recover it for you. Store it somewhere safe and offline. It is shown once.</p>
        <p className="select-all break-all rounded-2xl bg-bg/70 p-3 font-mono text-sm tracking-wider">{text}</p>
        <button className="btn-ghost" onClick={() => navigator.clipboard.writeText(text).catch(() => {})}><Copy className="h-4 w-4" />Copy</button>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved my recovery key somewhere safe.</label>
        <button className="btn-primary" disabled={!saved} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
