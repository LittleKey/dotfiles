# Fork Notes (local, 2026-10-23)

This is a local fork of [Raindrops-dev/opencode-stale-reasoning](https://github.com/Raindrops-dev/opencode-stale-reasoning)
adapted to **OpenCode v2.1.2**. Upstream was tested against v2.0.24 and no longer works here.

Source of record: `dotfiles/opencode/plugins/stale-reasoning/` (staged by the personal-profile
runtime as `plugins/stale-reasoning/`; the entry is `index.js` — renamed from upstream's
`index.mjs` because v2 discovery + the runtime's discovery-shim contract pin `index.js`, and a
staged dir exposing both extensions is refused). The live copy under
`~/.config/opencode/plugins/stale-reasoning/` is a deploy output, not the maintenance source.

## What broke in v2.1.2 (verified empirically)

- `ctx.session.hook("http.request"/"http.response")` no longer fire for the **session-drain replay
  path** (resume/revive). They still fire for normal in-session requests. Upstream's whole
  mark-on-400 / strip-on-request design sat on those two hooks, so marking never happened.
- The `retry` hook still fires for drain failures, but the drain error object shape changed:
  `error = { type, message, response }` with **no `status` property** (status, if anywhere, is in
  `error.response`). Upstream's `event.error.status === 400` guard is therefore always false.
- The drain error message is prefixed: `invalid_encrypted_content: The encrypted content for item
  rs_… could not be verified…` — upstream's `^`-anchored regex no longer matches.
- Provider HTTP calls in the server core do not go through a plugin-patchable `globalThis.fetch`
  (fetch monkey-patch saw zero provider traffic; core references the native binding directly).

## How this fork works

Three paths (A is the one that actually revives poisoned sessions on v2.1.2):

1. **Retry hook** (Path A): detects the error by message regex (unanchored) or code, adds the
   session to `poisoned`, and forces one immediate retry (`attempt <= 2`, once per error marker).
2. **Context/generate/title/compaction hooks** (Path B): these DO fire for drain requests. The
   encrypted reasoning rides on `part.providerMetadata.<provider> = { itemId, reasoningEncryptedContent, … }`.
   For a poisoned session, every such native payload is deleted from the outgoing request
   (messages are mutable and changes affect only the outgoing call — persisted history untouched).
   Trade-off vs upstream's per-item precision: after an account switch ALL of a session's stored
   encrypted reasoning is stale anyway, and stripping is cheaper than one 400→mark→strip cycle per
   item. New turns still store fresh (decryptable) reasoning; those are also stripped for poisoned
   sessions in this process lifetime — accepted loss of reasoning-replay continuity for those
   sessions, in exchange for guaranteed revival.
3. **fetch wrapper** (Path C): kept as belt-and-suspenders for any provider traffic that does go
   through the patched global (marks ids globally by request body, strips + transparently retries
   once). On v2.1.2 it is currently inert for provider traffic.

In-memory state (`poisoned`, `foreign`) resets on service restart; a poisoned session then pays
one 400 + forced retry before being re-marked. Self-healing, no persistence needed.

Verified 2026-10-23 on v2.1.2: session `ses_e9b804e0affeT2aXsqlY4m4Ghg` (26 encrypted parts)
revived end-to-end: 400 → retry FORCE → strip 26 → attempt 2 OK.

Debug log: `/tmp/opencode/stale-debug.log` (stale-debug lines: `retry FORCE`, `context … stripped=N`,
`fetch …`).
