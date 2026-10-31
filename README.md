# Couples App: Phase 1 (secure backend foundation)

Monorepo layout (only `apps/api` exists so far):

```
apps/api         Express + Mongoose + Socket.IO        <- Phase 1 + 2a (E2EE server side)
packages/crypto  libsodium E2EE primitives (client)    <- Phase 2a
packages/canvas-core  pure canvas logic + validation   <- Phase 3 (tested without a browser)
apps/web         Next.js + Tailwind                    <- Phase 2b (key storage, UI)
apps/mobile      Expo (only if native features are needed)
```

## Run

```bash
npm install                 # at repo root (npm workspaces)
cd apps/api
cp .env.example .env        # set JWT_ACCESS_SECRET and MONGODB_URI
npm run dev                 # Node >= 20.6 (uses --env-file)
npm test                    # spins up an in-memory MongoDB

# web (second terminal)
cd ../web && cp .env.example .env.local && npm run dev   # http://localhost:3000
(cd ../../packages/crypto && npm test)
```

## Status (honest)

| Area | State |
|---|---|
| Register / login / logout / refresh rotation + reuse detection / lockout / age gate | Implemented, tests written, **not yet executed** |
| Email verification | Token flow implemented; **mailer is a stub** (needs SES/Postmark/etc.) |
| Couple room + invitation (create, accept, confirm, reject, revoke, leave) | Implemented, tests written, **not yet executed** |
| Socket.IO auth + server-derived room join + typing/presence | Implemented, tests written, **not yet executed** |
| E2EE server side: devices, room-key envelopes, key versioning, encrypted messages (REST + socket), recovery blob | Implemented, tests written, **not yet executed** |
| E2EE client crypto (`packages/crypto`): wrap/unwrap, AEAD with bound AAD, padding, safety number, recovery key | Implemented, tests written, **not yet executed** |
| Web app (`apps/web`): auth, couple onboarding, device approval, recovery key, safety number, encrypted real-time chat with hearts | Implemented (Phase 2b), **never built or run**; typecheck blocked on missing dependencies |
| Live Love Canvas (Phase 3): encrypted ops, server-ordered seq, live previews, undo/redo, clear, text, stickers, backgrounds, PNG download, favorites, reconnect replay | Implemented. `canvas-core` tests **pass (11/11, run)**. API canvas tests + crypto test + the UI are **not yet run** |
| Password reset, device/session list, account deletion/export, MFA | Phase 1b |
| Chat, canvas, memories, media, calls, admin, subscriptions, web UI | Not started |

The code was syntax-checked with `node --check` only. Dependencies could not be installed in the
authoring sandbox (no network), so run `npm install && npm test` and send me any failures.

## Security design in brief

- Passwords: bcrypt (cost 12), 10-char minimum, 72-byte cap. Unknown-user logins do a dummy hash compare.
- Access JWT (15 min, HS256 pinned) + opaque refresh token in an httpOnly, SameSite=Strict cookie scoped to
  `/api/v1/auth`, stored only as a SHA-256 hash, rotated on every use. Replay revokes the device family.
- Access tokens carry `tokenVersion`; the user is reloaded on each request, so suspension is immediate.
- No endpoint accepts a couple id. The room is always derived from the authenticated user, and queries
  include `members: userId`. Non-members get 404, not 403, to avoid confirming existence.
- Invitation codes: 10 chars from a 30-symbol alphabet (~49 bits), stored hashed, expire in 72 h,
  single use, rate-limited (10 attempts/hour), and **require inviter confirmation** before anyone joins.
- Strict zod schemas reject unknown fields (no role injection) and non-string values (no `$gt` operators).
- Sockets: JWT handshake auth; clients never name rooms; membership re-verified every 15 s and on sensitive events.

## Data retention (to be enforced by a Phase 6 job)

Closed couples: content purged 30 days after closure (grace period for reconciliation). Resolved
invitations auto-delete 30 days after expiry (TTL index). Deleted accounts: personal data removed
within 30 days; audit logs and payment records kept as legally required.

## End-to-end encryption design

- The server stores: device **public** keys, encrypted room-key envelopes, opaque message ciphertext, and
  routing metadata (who, when, size, kind, key version). It never holds a private key or room key.
- Every message is bound by AEAD associated data to couple, sender, clientMsgId, keyVersion and kind, so
  the server cannot replay, re-attribute or move ciphertext. Payloads are padded to 128-byte blocks.
- Revoking a device bumps `couple.keyVersion`; sends with a stale version get `409 KEY_VERSION_STALE`
  until a remaining device uploads envelopes for the new version. Old envelopes are kept so history stays readable.
- **New devices must never receive keys automatically.** The client UI must show the new device's label and
  safety number and require approval on an existing device (a stolen session could otherwise register a device
  and be handed the key).
- Clients must compare the **safety number** (`safetyNumber()`) out of band to detect a malicious server
  substituting device keys. Without this check E2EE only protects against passive database leaks.
- libsodium keys are raw bytes in JS memory, stored in IndexedDB. They are NOT browser-non-extractable keys, so an XSS
  bug exposes them. Phase 2b adds a strict CSP and an optional device passcode. Native apps should use the OS keystore.
- Recovery: a random 256-bit key (shown once, 13 groups of 4) encrypts room keys into a blob stored server-side.
  Lose both devices and the recovery key and history is unrecoverable by design.
- Not E2EE (by nature): server-side search, moderation of content, malware scanning of uploads, and push-notification text.

## Web app notes (Phase 2b)

- Access token is held in memory only; the refresh token is an httpOnly SameSite=Strict cookie. In production
  the web app and API must share a registrable domain (e.g. app.example.com and api.example.com).
- First key: created by exactly one device (earliest device of the member with the smallest user id) to avoid split-brain.
  Every other device waits for approval from a trusted device, or restores with the recovery key.
- Removing a device rotates the room key to devices that already held the previous key.
  The recovery backup becomes stale after rotation until refreshed in Security (needs the existing recovery key).
- Known limits: CSP still allows inline scripts (Next bootstrap); no nonce-based CSP yet. If a revoker's client closes
  mid-rotation, the room can be stuck until the partner re-rotates (recovery path not built). Partner device keys are
  trusted via server registry + safety-number comparison (no automatic pinning/warning on change yet).
- Not built yet: dashboard/"Our Space" home, canvas, memories, calls, games, settings, light/dark toggle (follows OS), animations beyond hearts.

## Live Love Canvas (Phase 3)

- Every drawing action (stroke, text, sticker, undo, redo, clear, background) is an **op**, encrypted client-side with the room key
  and bound by AAD to couple, canvas, sender, op id and key version. The server stores ciphertext and assigns each op a
  monotonically increasing `seq` (the single source of drawing order). Clients rebuild the picture with `computeScene()`.
- **Live previews** (the partner's in-progress stroke, text as it is typed) travel as encrypted, volatile, never-stored socket events.
  On commit, the preview is replaced by the persisted op. A relaying server could replay old previews; they are cosmetic only.
- Reconnects: the client re-joins and fetches `GET /canvases/:id/ops?since=<lastSeq>` until caught up; duplicates are ignored by seq.
- Undo/redo are per-user (you can only undo your own work). `clear` wipes everything before it for both partners and is not undoable.
- Decrypted payloads are validated (`validateOp`) before drawing, because a partner's client is not trusted to be well-formed.
- Limits: 20,000 ops per canvas, 50 canvases per couple, strokes auto-split at 1,500 points. Opening a canvas replays all its ops
  (snapshot compaction is not built yet). Delete = archive for both partners; ciphertext purge belongs to the Phase 6 retention job.
- What the server can still do: see timing/size/count of ops, drop or delay ops. It cannot read or forge them.
- Not built: saving artwork into Memories (Phase 4; favorites and PNG download work now), stylus pressure curves, shapes tool.

Run the pure-logic tests anywhere with Node: `cd packages/canvas-core && npm test`.
