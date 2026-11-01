'use client';
import { useEffect, useRef, useState } from 'react';
import { Download, Play } from 'lucide-react';
import { formatBytes, kindForMime, type Descriptor } from '@couples/media-core';
import { fetchDecrypted, friendly, saveBlob } from '@/lib/mediaClient';

/**
 * Shows one encrypted file. Thumbnails load automatically (they are small); the full file is downloaded and
 * decrypted only when the user asks. Decrypted bytes are only ever given to <img>/<video>/<audio> with an allow-listed type.
 */
export default function MediaView({ desc, canDownload = true }: { desc: Descriptor; canDownload?: boolean }) {
  const kind = kindForMime(desc.mime);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    const list = urls.current;
    return () => { list.forEach((u) => URL.revokeObjectURL(u)); };
  }, []);

  useEffect(() => {
    if (!desc.thumb) return;
    let alive = true;
    fetchDecrypted({ id: desc.thumb.id, key: desc.thumb.key, mime: 'image/jpeg' })
      .then((b) => { if (!alive) return; const u = URL.createObjectURL(b); urls.current.push(u); setThumbUrl(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [desc.thumb]);

  async function open() {
    if (fullUrl || busy) return;
    setBusy(true); setErr(null); setProgress(0);
    try {
      const b = await fetchDecrypted(desc, { onProgress: setProgress });
      const u = URL.createObjectURL(b);
      urls.current.push(u);
      setBlob(b); setFullUrl(u);
    } catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  }

  const label = desc.name ?? (kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : desc.voice ? 'Voice note' : 'Audio');
  const secs = desc.dur ? `${Math.floor(desc.dur / 60)}:${String(Math.round(desc.dur % 60)).padStart(2, '0')}` : '';
  const status = busy ? <p className="text-xs opacity-80" role="status">Decrypting… {progress ? `${Math.round(progress * 100)}%` : ''}</p> : err ? <p className="text-xs text-red-500" role="alert">{err}</p> : null;
  const download = canDownload && blob ? (
    <button className="mt-1 inline-flex items-center gap-1 text-xs underline" onClick={() => saveBlob(blob, desc.name ?? label)}><Download className="h-3 w-3" aria-hidden />Save to device</button>
  ) : null;
  const box = desc.w && desc.h ? { aspectRatio: `${desc.w} / ${desc.h}`, maxWidth: 'min(100%, 320px)' } : { minHeight: 120, maxWidth: 'min(100%, 320px)' };

  if (kind === 'audio') {
    return (
      <div className="my-1 min-w-[220px]">
        {fullUrl ? <audio src={fullUrl} controls autoPlay className="w-full" aria-label={label} /> : (
          <button className="btn-ghost w-full justify-start" onClick={open} disabled={busy} aria-label={`Play ${label}`}><Play className="h-4 w-4" aria-hidden />{desc.voice ? 'Voice note' : label} {secs && `· ${secs}`}</button>
        )}
        {status}{download}
      </div>
    );
  }

  return (
    <div className="my-1">
      {fullUrl && kind === 'video' ? (
        <video src={fullUrl} controls autoPlay playsInline poster={thumbUrl ?? undefined} className="w-full rounded-2xl" style={{ maxWidth: 320 }} aria-label={label} />
      ) : fullUrl && kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={fullUrl} alt={label} className="rounded-2xl" style={{ maxWidth: 'min(100%, 420px)' }} />
      ) : (
        <button onClick={open} disabled={busy} aria-label={`Open ${label}${secs ? `, ${secs}` : ''}`} className="relative block overflow-hidden rounded-2xl border border-line bg-bg/60" style={box}>
          {thumbUrl && /* eslint-disable-next-line @next/next/no-img-element */ <img src={thumbUrl} alt="" className="h-full w-full object-cover" />}
          {!thumbUrl && <span className="grid h-full min-h-[120px] w-full place-items-center text-sm text-muted">{kind === 'video' ? '🎬' : '📷'} {formatBytes(desc.size)}</span>}
          {kind === 'video' && <span className="absolute inset-0 grid place-items-center bg-black/20"><Play className="h-8 w-8 text-white" aria-hidden /></span>}
          {secs && kind === 'video' && <span className="absolute bottom-1 right-2 rounded bg-black/60 px-1 text-xs text-white">{secs}</span>}
        </button>
      )}
      {status}{download}
    </div>
  );
}
