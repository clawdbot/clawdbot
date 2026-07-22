---
summary: "Image and media handling rules for send, gateway, and agent replies"
read_when:
  - Modifying media pipeline or attachments
title: "Image and media support"
---

The WhatsApp channel runs on Baileys Web. This page covers media handling rules for send, gateway, and agent replies.

## Goals

- Send media with an optional caption via `openclaw message send --media`.
- Allow auto-replies from the web inbox to include media alongside text.
- Keep per-type limits sane and predictable.

## CLI Surface

`openclaw message send --target <dest> --media <path-or-url> [--message <caption>]`

- `--media <path-or-url>` — attach media (image/audio/video/document); accepts local paths or URLs. Optional; caption can be empty for media-only sends.
- `--gif-playback` — treat video media as GIF playback (WhatsApp only).
- `--force-document` — send media as a document to avoid channel compression (Telegram, WhatsApp); applies to images, GIFs, and videos.
- `--reply-to <id>`, `--thread-id <id>`, `--pin`, `--silent` — delivery/threading options shared with text-only sends.
- `--dry-run` — print the resolved payload and skip sending.
- `--json` — print the result as JSON: `{ action, channel, dryRun, handledBy, messageId?, payload }` (`payload` carries the channel-specific send result, including any media reference).

## WhatsApp Web channel behavior

- Input: local file path **or** HTTP(S) URL.
- Flow: load into a buffer, detect media kind, then build the outbound payload per kind:
  - **Images:** optimized to fit under `channels.whatsapp.mediaMaxMb` (default 50MB). Opaque images are recompressed to JPEG (default side ladder starts at 2048px, descending on repeated size misses); images with transparency are kept as PNG. If the source is already an acceptable JPEG/PNG/WebP within the size and side-length budget, the original bytes are preserved unchanged instead of being recompressed. Animated GIFs are never re-encoded, only size-checked.
  - **Audio/voice:** unless already native voice audio (`.ogg`/`.opus`, or `audio/ogg`/`audio/opus`), outbound audio is transcoded via `ffmpeg` to Opus/OGG (48kHz mono, 64kbps, capped at 20 minutes) before sending as a voice note (`ptt: true`).
  - **Video:** pass-through up to 16MB.
  - **Documents:** anything else, up to 100MB, with filename preserved when available.
- WhatsApp GIF-style playback: send an MP4 with `gifPlayback: true` (CLI: `--gif-playback`) so mobile clients loop it inline.
- MIME detection prefers sniffed magic bytes, then the file extension, then response headers; a generic sniffed container (`application/octet-stream`, `zip`) never overrides a more specific extension mapping (for example XLSX vs ZIP).
- Caption comes from `--message` or `reply.text`; empty caption is allowed.
- Logging: non-verbose shows `↩️`/`✅`; verbose includes size and source path/URL.

<Note>
The 16MB audio/video and 100MB document figures above are the shared per-kind media defaults used when no explicit byte cap is passed. WhatsApp sends set an explicit cap from `channels.whatsapp.mediaMaxMb` (default 50MB), which applies uniformly across kinds for that account.
</Note>

## Auto-Reply Pipeline

- `getReplyFromConfig` returns a reply payload (or array of payloads) with `text?`, `mediaUrl?`, and `mediaUrls?` among other fields.
- When media is present, the web sender resolves local paths or URLs using the same pipeline as `openclaw message send`.
- Multiple media entries are sent sequentially if provided.

## Inbound Media To Commands

- When inbound web messages include media, OpenClaw downloads it to a temp file and exposes templating variables:
  - `{{MediaUrl}}` — pseudo-URL for the inbound media.
  - `{{MediaPath}}` — local temp path written before running the command.
- When a per-session Docker sandbox is enabled, inbound media is copied into the sandbox workspace and `MediaPath`/`MediaUrl` are rewritten to a sandbox-relative path like `media/inbound/<filename>`.
- Media understanding (configured via `tools.media.*` or shared `tools.media.models`) runs before templating and can insert `[Image]`, `[Audio]`, and `[Video]` blocks into `Body`.
  - Audio sets `{{Transcript}}` and uses the transcript for command parsing so slash commands still work.
  - Video and image descriptions preserve any caption text for command parsing.
  - If the active primary model already supports vision natively, OpenClaw skips the `[Image]` summary block and passes the original image to the model instead.
- By default only the first matching image/audio/video attachment is processed; use `tools.media.<capability>.attachments` to select multiple attachments.

## Limits and errors

**Outbound send caps (WhatsApp web send)**

- Images: up to `channels.whatsapp.mediaMaxMb` (default 50MB) after optimization.
- Audio/video: 16MB cap (shared default; overridden by `mediaMaxMb` when sending through WhatsApp).
- Documents: 100MB cap (shared default; overridden by `mediaMaxMb` when sending through WhatsApp).
- Oversize or unreadable media produces a clear error in logs, and the reply is skipped.

**Media understanding caps (transcription/description)**

- Image default: 10MB (override with `tools.media.image.maxBytes`, or per
  `tools.media.models[]` entry with `maxBytes`).
- Audio default: 20MB (override with `tools.media.audio.maxBytes`, or per entry).
- Video default: 50MB (override with `tools.media.video.maxBytes`, or per entry).
- Oversize media skips understanding, but the reply still goes through with the original body.

## Notes for Tests

- Cover send and reply flows for image/audio/document cases.
- Validate size bounds after image optimization and the voice-note flag for audio.
- Ensure multi-media replies fan out as sequential sends.

## Related

- [Camera capture](/nodes/camera)
- [Media understanding](/nodes/media-understanding)
- [Audio and voice notes](/nodes/audio)
