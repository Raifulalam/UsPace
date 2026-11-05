'use client';
import { useState } from 'react';
import { Bookmark, CornerUpLeft, Heart, Lock, Pencil, Pin, PinOff, Smile, Trash2, TriangleAlert } from 'lucide-react';
import { REACTIONS } from '@couples/space-core';
import type { ChatMessage } from '@/lib/types';
import MediaView from './MediaView';

export type ReactionChip = { emoji: string; count: number; mine: boolean };
type Props = {
  m: ChatMessage; mine: boolean; quoted: { name: string; text: string } | null; replyMissing: boolean; reactions: ReactionChip[]; seen: boolean; canEdit: boolean;
  onReact: (emoji: string) => void; onReply: () => void; onEdit: () => void; onPin: () => void; onSave: () => void; onDelete: () => void; onRetry: () => void;
};

const iconBtn = 'rounded-full p-1.5 text-muted hover:bg-line/50 hover:text-ink focus-visible:bg-line/50';

export default function MessageBubble({ m, mine, quoted, replyMissing, reactions, seen, canEdit, onReact, onReply, onEdit, onPin, onSave, onDelete, onRetry }: Props) {
  const [picker, setPicker] = useState(false);
  const live = m.state === 'ok' || m.state === 'sending' || m.state === 'failed';
  const actionable = Boolean(m.id) && m.state === 'ok';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <li id={m.id ? `m-${m.id}` : undefined} className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[82%]">
        <div className={`rounded-3xl px-4 py-2 ${mine ? 'bg-gradient-to-r from-accent to-accent2 text-white' : 'border border-line bg-surface'} ${m.state === 'sending' ? 'opacity-60' : ''} ${m.sticker ? '!bg-transparent !border-0 !px-1' : ''}`}>
          {m.pinned && <p className="mb-0.5 flex items-center gap-1 text-[10px] opacity-75"><Pin className="h-3 w-3" aria-hidden />Pinned</p>}
          {(quoted || replyMissing) && (
            <blockquote className="mb-1 rounded-xl border-l-2 border-current bg-black/10 px-2 py-1 text-xs opacity-90">
              {quoted ? <><strong>{quoted.name}</strong><br />{quoted.text}</> : <em>Earlier message</em>}
            </blockquote>
          )}
          {m.state === 'locked' && <span className="flex items-center gap-1 italic opacity-80"><Lock className="h-3 w-3" aria-hidden />Waiting for the key…</span>}
          {m.state === 'tampered' && <span className="flex items-center gap-1 italic"><TriangleAlert className="h-3 w-3" aria-hidden />Couldn’t verify this message</span>}
          {m.state === 'deleted' && <span className="italic opacity-70">Message deleted</span>}
          {live && (m.kind === 'heart' ? <Heart className="h-7 w-7 fill-current" aria-label="Heart" /> : m.sticker ? <span className="block text-6xl leading-tight" role="img" aria-label="Sticker">{m.sticker}</span> : (
            <>
              {m.media?.map((d) => <MediaView key={d.id} desc={d} />)}
              {m.text ? <p className="whitespace-pre-wrap break-words">{m.text}</p> : null}
            </>
          ))}
          <p className={`mt-0.5 flex items-center justify-end gap-2 text-[10px] ${m.sticker ? 'text-muted' : 'opacity-70'}`}>
            {m.state === 'failed' && <button className="underline" onClick={onRetry}>Not sent — retry</button>}
            {m.editedAt && <span>edited</span>}
            {time}
          </p>
        </div>

        {reactions.length > 0 && (
          <div className={`mt-1 flex flex-wrap gap-1 ${mine ? 'justify-end' : ''}`}>
            {reactions.map((r) => (
              <button key={r.emoji} onClick={() => onReact(r.emoji)} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
                className={`rounded-full border px-2 py-0.5 text-xs ${r.mine ? 'border-accent2 bg-accent2/20' : 'border-line bg-surface'}`}>{r.emoji} {r.count > 1 ? r.count : ''}</button>
            ))}
          </div>
        )}
        {seen && <p className="mt-0.5 text-right text-[10px] text-muted" aria-label="Seen by your partner">Seen</p>}

        {actionable && (
          <div className={`mt-0.5 flex items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100 ${mine ? 'justify-end' : ''}`}>
            {picker ? (
              <span className="flex gap-0.5 rounded-full border border-line bg-surface px-1" role="group" aria-label="Choose a reaction">
                {REACTIONS.map((e) => <button key={e} className="rounded-full p-1 text-lg hover:bg-line/50" aria-label={`React ${e}`} onClick={() => { onReact(e); setPicker(false); }}>{e}</button>)}
              </span>
            ) : (
              <>
                <button className={iconBtn} aria-label="React" onClick={() => setPicker(true)}><Smile className="h-4 w-4" /></button>
                <button className={iconBtn} aria-label="Reply" onClick={onReply}><CornerUpLeft className="h-4 w-4" /></button>
                {canEdit && <button className={iconBtn} aria-label="Edit message" onClick={onEdit}><Pencil className="h-4 w-4" /></button>}
                <button className={iconBtn} aria-label={m.pinned ? 'Unpin message' : 'Pin message'} onClick={onPin}>{m.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</button>
                {m.kind !== 'heart' && <button className={iconBtn} aria-label="Save to Our Memories" onClick={onSave}><Bookmark className="h-4 w-4" /></button>}
                {mine && <button className={iconBtn} aria-label="Delete message" onClick={onDelete}><Trash2 className="h-4 w-4" /></button>}
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
