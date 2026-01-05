# Changelog

**Why this looks different:** the project was renamed from **Clawdis → Clawdbot**. To make the transition clear, releases now use **date-based versions** (`YYYY.M.D`) and the changelog is **compressed** into milestone summaries. Full detail still lives in git history and the docs.

## Unreleased

### Fixes
- Onboarding: resolve CLI entrypoint when running via `npx` so gateway daemon install works without a build step.
- Linux: prompt to enable systemd lingering when installing/restarting the gateway user service (prevents logout/idle shutdowns).
- TUI: migrate key handling to the updated pi-tui Key matcher API.
- macOS: prefer gateway config reads/writes in local mode (fall back to disk if the gateway is unavailable).
- macOS: local gateway now connects via tailnet IP when bind mode is `tailnet`/`auto`.
- macOS: Connections settings now use a custom sidebar to avoid toolbar toggle issues, with rounded styling and full-width row hit targets.
- macOS: drop deprecated `afterMs` from agent wait params to match gateway schema.
- Auth: add OpenAI Codex OAuth support and migrate legacy oauth.json into auth.json.
- Model: `/model` list shows auth source (masked key or OAuth email) per provider.
- Model: `/model list` is an alias for `/model`.
- Model: `/model` output now includes auth source location (env/auth.json/models.json).
- Docs: clarify auth storage, migration, and OpenAI Codex OAuth onboarding.
- Sandbox: copy inbound media into sandbox workspaces so agent tools can read attachments.
- Control UI: show a reading indicator bubble while the assistant is responding.
- Control UI: stabilize chat streaming during tool runs (no flicker/vanishing text; correct run scoping).
- Status: show runtime (docker/direct) and move shortcuts to `/help`.
- Status: show model auth source (api-key/oauth).
- Block streaming: avoid splitting Markdown fenced blocks and reopen fences when forced to split.
- Docs: document systemd lingering and logged-in session requirements on macOS/Windows.

### Maintenance
- Deps: bump pi-* stack, Slack SDK, discord-api-types, file-type, zod, and Biome.
- Skills: add CodexBar model usage helper with macOS requirement metadata.
- Lint: organize imports and wrap long lines in reply commands.

## 2026.1.5-3

### Fixes
- NPM package: include missing runtime dist folders (slack/signal/imessage/tui/wizard/control-ui/daemon) to avoid `ERR_MODULE_NOT_FOUND` in Node 25 npx installs.

## 2026.1.5-2

### Fixes
- NPM package: include `dist/sessions` so `clawdbot agent` resolves session helpers in npx installs.
- Node 25: avoid unsupported directory import by targeting `qrcode-terminal/vendor/QRCode/*.js` modules.

## 2026.1.5-1

### Fixes
- NPM package: include `dist/sessions` so `clawdbot agent` resolves session helpers in npx installs.
- Node 25: avoid unsupported directory import by targeting `qrcode-terminal/vendor/QRCode/index.js`.

## 2026.1.5

### Highlights
- Models: add image-specific model config (`agent.imageModel` + fallbacks) and scan support.
- Agent tools: new `image` tool routed to the image model (when configured).
- Config: default model shorthands (`opus`, `sonnet`, `gpt`, `gpt-mini`, `gemini`, `gemini-flash`).
- Docs: document built-in model shorthands + precedence (user config wins).

### Fixes
- Control UI: render Markdown in tool result cards.
- Control UI: prevent overlapping action buttons in Discord guild rules on narrow layouts.
- Android: tapping the foreground service notification brings the app to the front. (#179) — thanks @Syhids
- Cron tool uses `id` for update/remove/run/runs (aligns with gateway params). (#180) — thanks @adamgall
- Control UI: chat view uses page scroll with sticky header/sidebar and fixed composer (no inner scroll frame).
- macOS: treat location permission as always-only to avoid iOS-only enums. (#165) — thanks @Nachx639
- macOS: make generated gateway protocol models `Sendable` for Swift 6 strict concurrency. (#195) — thanks @andranik-sahakyan
- macOS: bundle QR code renderer modules so DMG gateway boot doesn't crash on missing qrcode-terminal vendor files.
- macOS: parse JSON5 config safely to avoid wiping user settings when comments are present.
- WhatsApp: suppress typing indicator during heartbeat background tasks. (#190) — thanks @mcinteerj
- WhatsApp: mark offline history sync messages as read without auto-reply. (#193) — thanks @mcinteerj
- Discord: avoid duplicate replies when a provider emits late streaming `text_end` events (OpenAI/GPT).
- CLI: use tailnet IP for local gateway calls when bind is tailnet/auto (fixes #176).
- Env: load global `$CLAWDBOT_STATE_DIR/.env` (`~/.clawdbot/.env`) as a fallback after CWD `.env`.
- Env: optional login-shell env fallback (opt-in; imports expected keys without overriding existing env).
- Agent tools: OpenAI-compatible tool JSON Schemas (fix `browser`, normalize union schemas).
- Onboarding: when running from source, auto-build missing Control UI assets (`pnpm ui:build`).
- Discord/Slack: route reaction + system notifications to the correct session (no main-session bleed).
- Agent tools: honor `agent.tools` allow/deny policy even when sandbox is off.
- Discord: avoid duplicate replies when OpenAI emits repeated `message_end` events.
- Commands: unify /status (inline) and command auth across providers; group bypass for authorized control commands; remove Discord /clawd slash handler.
- Control UI: render Markdown in chat messages (sanitized).


## 2026.1.4

### Highlights
- Rename completion: all CLIs, paths, bundle IDs, env vars, and docs standardized on **Clawdbot**.
- Agent-to-agent relay: `sessions_send` ping‑pong with `REPLY_SKIP` plus announce step with `ANNOUNCE_SKIP`.
- Gateway quality-of-life: config hot reload, port config support, and Control UI base paths.
- Sandbox additions: per-session Docker sandbox with hardened limits + optional sandboxed Chromium.
- New node capability: `location.get` across macOS/iOS/Android (CLI + tools).
- Models CLI: scan OpenRouter free models (tools/images), manage aliases/fallbacks, and show last-used model in status.

### Breaking
- Tool names drop the `clawdbot_` prefix (`browser`, `canvas`, `nodes`, `cron`, `gateway`).
- Bash tool removes node-pty `stdinMode: "pty"` support (use tmux for real TTYs).
- Primary session key is fixed to `main` (or `global` for global scope).

### Fixes
- Doctor migrates legacy Clawdis config/service installs and normalizes sandbox Docker names.
- Doctor checks sandbox image availability and offers to build or fall back to legacy images.
- Presence beacons keep node lists fresh; Instances view stays accurate.
- Block streaming/chunking reliability (Telegram/Discord ordering, fewer duplicates).
- WhatsApp GIF playback for MP4-based GIFs.
- Onboarding + Control UI basePath handling fixes and UI polish.
- Clearer tool summaries, reduced log noise, and safer watchdog/queue behavior.
- Canvas host watcher resilience; build and packaging edge cases cleaned up.

### Docs
- Sandbox setup, hot reload, port config, and session announce step coverage.
- Skills and onboarding clarifications + additional examples.

## 2026.1.3 (beta 5)

### Breaking
- Skills config moved under `skills.*` (new `skills.entries`, `skills.allowBundled`).
- Group session keys now `surface:group:<id>` / `surface:channel:<id>`; legacy `group:*` removed.
- Discord config refactor; `discord.allowFrom` + `discord.requireMention` removed.
- Discord/Telegram require `enabled: true` in config when using env tokens.
- Routing `allowFrom`/mention settings moved to per-surface group settings.

### Highlights
- Talk Mode (continuous voice) with ElevenLabs TTS on macOS/iOS/Android.
- Discord: expanded tool actions, richer routing, and threaded reply tags.
- Auto-reply queue modes + session model overrides; TUI upgrades.
- Nix mode (declarative config) and Docker setup flow.
- Onboarding wizard + configure/doctor/update flows.
- Signal + iMessage providers; new skills (Trello, Things, Notes/Reminders, tmux coding).
- Browser tooling upgrades (remote CDP, no-sandbox, profiles).

### Fixes
- macOS codesign/TCC hardening and menu/UI stability improvements.
- Streaming/typing fixes; per-provider chunk limit tuning.
- Remote gateway auth + token handling tightened.
- Camera capture reliability and media sizing fixes.

## 2025.12.27 (betas 3–4)

### Highlights
- First-class tools replace `clawdbot-*` skills (browser, canvas, nodes, cron).
- Per-session model selection and custom model providers.
- Group activation commands; Discord provider for DMs/guilds.
- Gateway webhooks + Gmail Pub/Sub hooks.
- Command queue modes + `agent.maxConcurrent` cap.
- Background bash tasks with `process` tool; gateway in-process restart.

### Fixes
- Packaging fixes, heartbeat cleanup, WhatsApp reconnect reliability.
- macOS menu/Chat UI polish and presence reporting fixes.

## 2025.12.21 (beta 2)

### Highlights
- Bundled gateway packaging + DMG distribution pipeline.
- Skills platform (bundled/managed/workspace) with install gating + UI.
- Onboarding polish and agent UX improvements.
- Canvas host served from Gateway; browser control simplification.

## 2025.12.19 (beta 1)

### Highlights
- First Clawdbot release: Gateway WS control plane + optional Bridge.
- macOS menu bar companion app with Voice Wake + WebChat.
- iOS node pairing with Canvas surface.
- WhatsApp groups, thinking/verbose directives, health/status tooling.

### Breaking
- Switched to Pi-only agent runtime; legacy providers removed.
- Gateway became the single source of truth (no ad-hoc direct sends).

## 2025.12.05–2025.12.03 (pre-Clawdbot)

### Highlights
- Pi-only agent path and web-only gateway workflow.
- Thinking/verbose directives, group chat support, and heartbeat controls.
- `clawdbot agent` CLI added; session tables and health reporting.

## 2025.11.28–2025.11.25 (early web-only)

- Heartbeat CLI + interval handling.
- Media MIME sniffing, size caps, and timeout fallbacks.
- Web provider reconnects and early stability fixes.
