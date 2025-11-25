# Image Support Specification (draft) — 2025-11-25

This document defines how `warelay` should handle sending and replying with images across both providers. It is intentionally implementation-ready and keeps the UX consistent with existing CLI patterns and Tailscale Funnel usage.

## Goals
- Allow sending an image with an optional caption via `warelay send` for both providers.
- Allow auto-replies (Twilio webhook, Twilio poller, Web inbox) to return an image (optionally with text) when configured.
- Keep the “one command at a time” queue intact; media fetch/serve must not block other replies longer than necessary.
- Avoid introducing new external services: reuse the existing Tailscale Funnel port to host media for Twilio.

## CLI & Config Surface
- `warelay send --media <path-or-url> [--message <caption>] [--provider twilio|web]`
  - `--media` optional; `--message` remains required for now (caption can be empty string to send only media).
  - `--dry-run` prints the resolved payload including hosted URL (twilio) or file path (web).
  - `--json` emits `{ provider, to, sid/messageId, mediaUrl, caption }`.
- Config auto-reply (`~/.warelay/warelay.json`):
  - Add `inbound.reply.mediaUrl?: string` (templated like `reply.text`).
  - Return shape from `getReplyFromConfig` becomes `{ text?: string; mediaUrl?: string }`.
  - Both `text` and `mediaUrl` optional; at least one must be present to send a reply.

## Provider Behavior
### Web (Baileys)
- Input: local file path **or** HTTP(S) URL.
- Flow: load into Buffer (max 5 MB), send via `sock.sendMessage(jid, { image: buffer, caption })`.
- Caption uses `--message` or `reply.text`; if caption is empty, send media-only.
- Logging: non-verbose shows `↩️`/`✅` with caption; verbose includes `(media, <bytes>B, <ms>ms fetch)`.

### Twilio
- Twilio API requires a public HTTPS `MediaUrl`; it will not accept local paths.
- Hosting strategy: reuse the webhook/Funnel port.
  - When `--media` is a local path, copy to temp dir (`~/.warelay/media/<uuid>`), serve at `/media/<uuid>` on the existing Express app started for webhook/up, or spin up a short-lived server on demand for `send`.
  - `MediaUrl` = `https://<tailnet-host>.ts.net/media/<uuid>`.
  - Files auto-removed after TTL (default 2 minutes) or after first successful fetch (best-effort).
  - Enforce size limit 5 MB; reject early with clear error.
- If `--media` is already an HTTPS URL, pass through unchanged.
- Fallback: if Funnel is not enabled (or host unknown) and a local path is provided, fail with guidance to run `warelay up` (or pass a URL instead).

## Hosting/Server Details
- Extend `startWebhook` Express app:
  - Static media route `/media/:id` reading from temp dir.
  - 404/410 if expired or missing.
  - Optional `?delete=1` to self-delete after fetch (used by Twilio fetch hook if we detect first hit).
- Temp storage: `~/.warelay/media`; cleaned on startup (remove files older than 15 minutes) and during TTL eviction.
- Security: no directory listing; only UUID file names; CORS open (Twilio fetch); content-type derived from `mime-types` lookup by extension or `content-type` header on download, else `application/octet-stream`.

## Auto-Reply Pipeline
- `getReplyFromConfig` returns `{ text?, mediaUrl? }`.
- Webhook / Twilio poller:
  - If `mediaUrl` present, include `mediaUrl` in Twilio message payload; caption = `text` (may be empty).
  - If only `text`, behave as today.
- Web inbox:
  - If `mediaUrl` present, fetch/resolve same as send (local path or URL), send via Baileys with caption.

## Inbound Media to Commands (Claude etc.)
- For completeness: when inbound Twilio/Web messages include media, download to temp file, expose templating variables:
  - `{{MediaUrl}}` original URL (Twilio) or pseudo-URL (web).
  - `{{MediaPath}}` local temp path written before running the command.
- Size guard: only download if ≤5 MB; else skip and log.

## Errors & Messaging
- Local path with twilio + Funnel disabled → error: “Twilio media needs a public URL; start `warelay up`/`warelay webhook` with Funnel or pass an https:// URL.”
- File too large (>5 MB) → “Media exceeds 5 MB limit; resize or host elsewhere.”
- Download failure for web provider → “Failed to load media from <source>; skipping send.”

## Tests to Add
- Twilio: dry-run shows hosted URL; send payload includes `mediaUrl`; rejects when Funnel host missing.
- Web: local path sends image (mock Baileys buffer assertion).
- Config: zod allows `mediaUrl`, returns combined object; command auto-reply handles `text+media`, `media-only`.
- Media server: serves file, enforces TTL, returns 404 after cleanup.

## Open Decisions (confirm before coding)
- TTL for temp media (proposal: 2 minutes, cleanup at start + interval).
- One-file-per-send vs. batching: default to one-file-per-send; multi-attach not supported.
- Should `warelay send --provider twilio --media` implicitly start the media server (even if webhook not running), or require `warelay up/webhook` already active? (Proposal: auto-start lightweight server on demand, auto-stop after media is fetched or TTL.)
