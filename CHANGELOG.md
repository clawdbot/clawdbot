# Changelog

## 1.3.2 — 2025-12-03

### Bug Fixes
- Tau/Pi RPC replies are now buffered until the assistant turn finishes and only completed assistant `message_end` events are emitted, preventing duplicate or partial WhatsApp messages.
- Command auto-replies return the parsed assistant texts array only (no deprecated `text` field), while preserving single-payload callers and keeping multi-message replies intact.
- WhatsApp Web auto-replies now fall back to sending the caption text if media delivery fails, so users still see a reply instead of silence.
- Outbound chunking now prefers newlines and word boundaries and only splits when exceeding platform limits, keeping multi-paragraph replies in a single message unless necessary.
- Heartbeat replies now normalize array payloads for both web and Twilio paths and safely handle optional `heartbeatCommand`, preventing TS build failures and runtime crashes when agents return multiple messages.

### Testing
- Updated agent and auto-reply parsers plus web media send fallbacks; test suite adjusted and now passing after the RPC/message handling refactors.

## 1.3.1 — 2025-12-02

### Security
- Hardened the relay IPC socket: now lives under `~/.warelay/ipc`, enforces 0700 dir / 0600 socket perms, rejects symlink or foreign-owned paths, and includes unit tests to lock in the behavior.
- `warelay logout` now also prunes the shared session store (`~/.warelay/sessions.json`) alongside WhatsApp Web credentials, reducing leftover state after unlinking.
- Logging now rolls daily to `/tmp/warelay/warelay-YYYY-MM-DD.log` (or custom dir) and prunes files older than 24h to reduce data retention.
- Media server now rejects symlinked files and ensures resolved paths stay inside the media directory, closing traversal via symlinks; added regression test. (Thanks @joaohlisboa)

### Performance
- Web auto-replies using the Pi agent now keep a single long-lived `tau` process in RPC mode instead of spawning per message, eliminating cold-start latency while preserving session/cwd handling.

### Bug Fixes
- Media downloads now follow up to 5 redirects and still derive MIME/extension from sniffed content or headers; added regression test for redirected downloads.
- Hosted media responses set `Content-Type` from sniffed MIME (not the file name) and still clean up single-use files after send.
- Claude system prompt is guaranteed to be included on the first session turn even when `sendSystemOnce` is enabled, while later turns stay system-free.
- Media server deletes served files right after the response finishes (instead of a fixed timeout) while keeping MIME sniffing and single-use semantics.
- Tau RPC result typing now exposes `signal`/`killed` fields so TS builds align with runtime data.

## 1.3.0 — 2025-12-02

### Highlights
- **Pluggable agents (Claude, Pi, Codex, Opencode):** New `inbound.reply.agent` block chooses the CLI and parser per command reply; per-agent argv builders inject the right flags/identity/prompt handling and parse NDJSON streams, enabling Pi/Codex swaps without changing templates.
- **Safety stop words for agents:** If an inbound message is exactly `stop`, `esc`, `abort`, `wait`, or `exit`, warelay immediately replies “Agent was aborted.”, kills the pending agent run, and marks the session so the next prompt is prefixed with a reminder that the previous run was aborted.
- **Agent session reliability:** Only Claude currently returns a `session_id` that warelay persists; other agents (Gemini, Opencode, Codex, Pi) don’t emit stable session identifiers, so multi-turn continuity may reset between runs for those harnesses.

### Bug Fixes
- **Empty result field handling:** Fixed bug where Claude CLI returning `result: ""` (empty string) would cause raw JSON to be sent to WhatsApp instead of being treated as valid empty output. Changed truthy check to explicit type check in `command-reply.ts`.
- **Response prefix on heartbeat replies:** Fixed `responsePrefix` (e.g., `🦞`) not being applied to heartbeat alert messages. The prefix was only applied in the regular message handler, not in `runReplyHeartbeat`.
- **User-visible error messages:** Command failures (non-zero exit, killed processes, exceptions) now return user-friendly error messages to WhatsApp instead of silently failing with empty responses.
- **Test session isolation:** Fixed tests corrupting production `sessions.json` by mocking session persistence in all test files.
- **Signal session corruption prevention:** Added IPC mechanism so `warelay send` and `warelay heartbeat` reuse the running relay's WhatsApp connection instead of creating new Baileys sockets. Previously, using these commands while the relay was running could corrupt the Signal session ratchet (both connections wrote to the same auth state), causing the relay's subsequent sends to fail silently.
- **Web send media kinds:** `sendMessageWeb` now honors media kind when sending via WhatsApp Web: audio → PTT with correct opus mimetype, video → video, image → image, other → document with filename. Previously all media were sent as images, breaking audio/video/doc sends.

### Changes
- **IPC server for relay:** The web relay now starts a Unix socket server at `~/.warelay/relay.sock`. Commands like `warelay send --provider web` automatically connect via IPC when the relay is running, falling back to direct connection otherwise.
- **Batched inbound messaging with timestamps:** When multiple WhatsApp messages queue up, they’re sent to the agent in one combined batch, each line timestamped consistently to preserve ordering and context.
- **Typing indicator after IPC send:** After sending a message via IPC (e.g., `warelay send`), the relay now automatically shows the typing indicator ("composing") to signal that more messages may be coming.
- **Auto-recovery from stuck WhatsApp sessions:** Added watchdog timer that detects when WhatsApp event emitter stops firing (e.g., after Bad MAC decryption errors) and automatically restarts the connection after 30 minutes of no message activity. Heartbeat logging now includes `minutesSinceLastMessage` and warns when >30 minutes without messages. The 30-minute timeout is intentionally longer than typical `heartbeatMinutes` configs to avoid false positives.
- **Early allowFrom filtering:** Unauthorized senders are now blocked in `inbound.ts` BEFORE encryption/decryption attempts, preventing Bad MAC errors from corrupting session state. Previously, messages from unauthorized senders would trigger decryption failures that could silently kill the event emitter.
- **Test isolation improvements:** Mock `loadConfig()` in all test files to prevent loading real user config (with emojis/prefixes) during tests. Default test config now has no prefixes/timestamps for cleaner assertions.
- **Same-phone mode (self-messaging):** warelay now supports running on the same phone number you message from. This enables setups where you chat with yourself to control an AI assistant. Same-phone mode (`from === to`) is always allowed, even without configuring `allowFrom`. Echo detection prevents infinite loops by tracking recently sent message text and skipping auto-replies when incoming messages match.
- **Echo detection:** The `fromMe` filter in `inbound.ts` is deliberately removed for same-phone setups; instead, text-based echo detection in `auto-reply.ts` tracks sent messages in a bounded Set (max 100 entries) and skips processing when a match is found.
- **Same-phone detection logging:** Verbose mode now logs `📱 Same-phone mode detected` when `from === to`.
- **Configurable same-phone marker:** New `inbound.samePhoneMarker` config option to customize the prefix added to messages in same-phone mode (default: `[same-phone]`). Set it to something cute like `[🦞 same-phone]` to help distinguish bot replies.

## 1.2.2 — 2025-11-28

### Changes
- **Manual heartbeat sends:** `warelay heartbeat` accepts `--message/--body` with `--provider web|twilio` to push real outbound messages through the same plumbing; `--dry-run` previews payloads without sending.

## Unreleased

### Fixed
- Support multiple assistant text replies when using Tau RPC: agents now emit `texts` arrays and command auto-replies deliver each message separately without leaking raw JSON.
- Normalized agent parsers (pi/claude/opencode/codex/gemini) to the new plural output shape.
- Enforce outbound text size caps: WhatsApp/Twilio messages chunked at 1600 chars; web replies chunked at 4000 chars.

### Changes
- **Heartbeat backpressure:** Web reply heartbeats now check the shared command queue and skip while any command/Claude runs are in flight, preventing concurrent prompts during long-running requests.
- **Isolated session fixtures in web tests:** Heartbeat/auto-reply tests now create temporary session stores instead of using the default `~/.warelay/sessions.json`, preventing local config pollution during test runs.

## 1.2.1 — 2025-11-28

### Changes
- **Media MIME-first handling:** Media loading now sniffs magic bytes/header before trusting extensions for both providers; local files with the wrong suffix still get correct MIME and image recompression.
- **Hosted media extensions:** Saved/hosted media (web inbound, webhook hosting, Twilio hosting) now writes files with an extension derived from detected MIME (e.g., `.jpg`, `.png`, `.mp4`), so downstream CLI sends carry the right Content-Type. Added tests covering inbound Baileys downloads and buffer saves.

### Planned / in progress
- **Heartbeat targeting quality:** Allow `warelay heartbeat --provider web --all` to fall back to `inbound.allowFrom` when no sessions exist, and surface a clear error when neither sessions nor allow-list entries are present. Add verbose log lines that state exactly which recipients were chosen and why.
- **Heartbeat delivery preview (Claude path):** Add a dry-run mode that resolves the heartbeat reply (text/media) and prints it without sending, to help test Claude prompt changes safely.
- **Simulated inbound hook (debug):** Optional local-only endpoint to inject synthetic inbound messages into the web relay loop, sharing the same command queue and reply path. Useful for testing auto-replies and heartbeats without WhatsApp.

## 1.2.0 — 2025-11-27

### Changes
- **Heartbeat UX:** Default heartbeat interval is now 10 minutes for command mode. Heartbeat prompt is `HEARTBEAT ultrathink`; replies of exactly `HEARTBEAT_OK` suppress outbound messages but still log. Fallback heartbeats no longer start fresh sessions when none exist, and skipped heartbeats do not refresh session `updatedAt` (so idle expiry still works). Session-level `heartbeatIdleMinutes` is supported.
- **Heartbeat tooling:** `warelay heartbeat` accepts `--session-id` to force resume a specific Claude session. Added `--heartbeat-now` to relay startup, plus helper scripts `warelay relay:heartbeat` and `warelay relay:heartbeat:tmux` to fire a heartbeat immediately when the relay launches.
- **Prompt structure for Claude:** Introduced one-time `sessionIntro` (system prompt) with per-message `bodyPrefix` of `ultrathink`, so the full prompt is sent only on the first turn; later turns only prepend `ultrathink`. Session idle extended to 7 days (configurable).
- **Robustness:** Added WebSocket error guards for Baileys sessions; global `unhandledRejection`/`uncaughtException` handlers log and exit cleanly. Web inbound now resolves WhatsApp Linked IDs (`@lid`) using Baileys reverse mapping. Media hosting during Twilio webhooks uses the shared host module and is covered by tests.
- **Docs:** README now highlights the Clawd setup with links, and `docs/claude-config.md` contains the live personal config (home folder, prompts, heartbeat behavior, and session settings).

## 1.1.0 — 2025-11-26

### Changes
- Web auto-replies now resize/recompress media and honor `inbound.reply.mediaMaxMb` in `~/.warelay/warelay.json` (default 5 MB) to avoid provider/API limits.
- Web provider now detects media kind (image/audio/video/document), logs the source path, and enforces provider caps: images ≤6 MB, audio/video ≤16 MB, documents ≤100 MB; images still target the configurable cap above with resize + JPEG recompress.
- Sessions can now send the system prompt only once: set `inbound.reply.session.sendSystemOnce` (optional `sessionIntro` for the first turn) to avoid re-sending large prompts every message.
- While commands run, typing indicators refresh every 30s by default (tune with `inbound.reply.typingIntervalSeconds`); helps keep WhatsApp “composing” visible during longer Claude runs.
- Optional voice-note transcription: set `inbound.transcribeAudio.command` (e.g., OpenAI Whisper CLI) to turn inbound audio into text before templating/Claude; verbose logs surface when transcription runs. Prompts now include the original media path plus a `Transcript:` block so models see both.
- Auto-reply command replies now return structured `{ payload, meta }`, respect `mediaMaxMb` for local media, log Claude metadata, and include the command `cwd` in timeout messages for easier debugging.
- Added unit coverage for command helper edge cases (Claude flags, session args, media tokens, timeouts) and transcription download/command invocation.
- Split the monolithic web provider into focused modules under `src/web/` plus a barrel; added logout command, no-fallback relay behavior, and web-only relay start helper.
- Introduced structured reconnect/heartbeat logging (`web-reconnect`, `web-heartbeat`), bounded exponential backoff with CLI and config knobs, and a troubleshooting guide at `docs/refactor/web-relay-troubleshooting.md`.
- Relay help now prints effective heartbeat/backoff settings when running in web mode for quick triage.

## 1.0.4 — 2025-11-25

### Changes
- Auto-replies now send a WhatsApp fallback message when a command/Claude run hits the timeout, including up to 800 chars of partial stdout so the user still sees progress.
- Added tests covering the new timeout fallback behavior and partial-output truncation.
- Web relay auto-reconnects after Baileys/WebSocket drops (with log-out detection) and exposes close events for monitoring; added tests for close propagation and reconnect loop.

## 0.1.3 — 2025-11-25

### Features
- Added `cwd` option to command reply config for setting the working directory where commands execute. Essential for Claude Code to have proper project context.
- Added configurable file-based logging (default `/tmp/warelay/warelay.log`) with log level set via `logging.level` in `~/.warelay/warelay.json`; verbose still forces debug.

### Developer notes
- Command auto-replies now pass `{ timeoutMs, cwd }` into the command runner; custom runners/tests that stub `runCommandWithTimeout` should accept the options object as well as the legacy numeric timeout.

## 0.1.2 — 2025-11-25

### CI/build fix
- Fixed commander help configuration (`subcommandTerm`) so TypeScript builds pass in CI.

## 0.1.1 — 2025-11-25

### CLI polish
- Added a proper executable shim so `npx warelay@0.1.x --help` runs the CLI directly.
- Help/version banner now uses the README tagline with color, and the help footer includes colored examples with short explanations.
- `send` and `status` gained a `--verbose` flag for consistent noisy output when debugging.
- Lowercased branding in docs/UA; web provider UA is `warelay/cli/0.1.1`.


## 0.1.0 — 2025-11-25

### CLI & Providers
- Bundles a single `warelay` CLI with commands for `send`, `relay`, `status`, `webhook`, `login`, and tmux helpers `relay:tmux` / `relay:tmux:attach` (see `src/cli/program.ts`); `webhook` accepts `--ingress tailscale|none`.
- Supports two messaging backends: **Twilio** (default) and **personal WhatsApp Web**; `relay --provider auto` selects Web when a cached login exists, otherwise falls back to Twilio polling (`provider-web.ts`, `cli/program.ts`).
- `send` can target either provider, optionally wait for delivery status (Twilio only), output JSON, dry-run payloads, and attach media (`commands/send.ts`).
- `status` merges inbound + outbound Twilio traffic with formatted lines or JSON output (`commands/status.ts`, `twilio/messages.ts`).

### Webhook, Funnel & Port Management
- `webhook` starts an Express server for inbound Twilio callbacks, logs requests, and optionally auto-replies with static text or config-driven replies (`twilio/webhook.ts`, `commands/webhook.ts`).
- `webhook --ingress tailscale` automates end-to-end webhook setup: ensures required binaries, enables Tailscale Funnel, starts the webhook on the chosen port/path, discovers the WhatsApp sender SID, and updates Twilio webhook URLs with multiple fallbacks (`commands/up.ts`, `infra/tailscale.ts`, `twilio/update-webhook.ts`, `twilio/senders.ts`).
- Guardrails detect busy ports with helpful diagnostics and aborts when conflicts are found (`infra/ports.ts`).

### Auto-Reply Engine
- Configurable via `~/.warelay/warelay.json` (JSON5) with allowlist support, text or command-driven replies, templating (`{{Body}}`, `{{From}}`, `{{MediaPath}}`, etc.), optional body prefixes, and per-sender or global conversation sessions with `/new` resets and idle expiry (`auto-reply/reply.ts`, `config/config.ts`, `config/sessions.ts`, `auto-reply/templating.ts`).
- Command replies run through a process-wide FIFO queue to avoid concurrent executions across webhook, poller, and web listener flows (`process/command-queue.ts`); verbose mode surfaces wait times.
- Claude CLI integration auto-injects identity, output-format flags, session args, and parses JSON output while preserving metadata (`auto-reply/claude.ts`, `auto-reply/reply.ts`).
- Typing indicators fire before replies for Twilio, and Web provider sends “composing/available” presence when possible (`twilio/typing.ts`, `provider-web.ts`).

### Media Pipeline
- `send --media` works on both providers: Web accepts local paths or URLs; Twilio requires HTTPS and transparently hosts local files (≤5 MB) via the Funnel/webhook media endpoint, auto-spawning a short-lived media server when `--serve-media` is requested (`commands/send.ts`, `media/host.ts`, `media/server.ts`).
- Auto-replies may include `mediaUrl` from config or command output (`MEDIA:` token extraction) and will host local media when needed before sending (`auto-reply/reply.ts`, `media/parse.ts`, `media/host.ts`).
- Inbound media from Twilio or Web is downloaded to `~/.warelay/media` with TTL cleanup and passed to commands via `MediaPath`/`MediaType` for richer prompts (`twilio/webhook.ts`, `provider-web.ts`, `media/store.ts`).

### Relay & Monitoring
- `relay` polls Twilio on an interval with exponential-backoff resilience, auto-replying to inbound messages, or listens live via WhatsApp Web with automatic read receipts and presence updates (`cli/program.ts`, `twilio/monitor.ts`, `provider-web.ts`).
- `send` + `waitForFinalStatus` polls Twilio until a terminal delivery state (delivered/read) or timeout, with clear failure surfaces (`twilio/send.ts`).

### Developer & Ops Ergonomics
- `relay:tmux` helper restarts/attaches to a dedicated `warelay-relay` tmux session for long-running relays (`cli/relay_tmux.ts`).
- Environment validation enforces Twilio credentials early and supports either auth token or API key/secret pairs (`env.ts`).
- Shared logging utilities, binary checks, and runtime abstractions keep CLI output consistent (`globals.ts`, `logger.ts`, `infra/binaries.ts`).
