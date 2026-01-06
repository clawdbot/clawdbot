# Changelog

**Why this looks different:** the project was renamed from **Clawdis → Clawdbot**. To make the transition clear, releases now use **date-based versions** (`YYYY.M.D`) and the changelog is **compressed** into milestone summaries. Full detail still lives in git history and the docs.

## Unreleased

### Breaking
- **SECURITY (update ASAP):** inbound DMs are now **locked down by default** on Telegram/WhatsApp/Signal/iMessage/Discord/Slack.
  - Previously, if you didn’t configure an allowlist, your bot could be **open to anyone** (especially discoverable Telegram bots).
  - New default: DM pairing (`dmPolicy="pairing"` / `discord.dm.policy="pairing"` / `slack.dm.policy="pairing"`).
  - To keep old “open to everyone” behavior: set `dmPolicy="open"` and include `"*"` in the relevant `allowFrom` (Discord/Slack: `discord.dm.allowFrom` / `slack.dm.allowFrom`).
  - Approve requests via `clawdbot pairing list --provider <provider>` + `clawdbot pairing approve --provider <provider> <code>` (Telegram also supports `clawdbot telegram pairing ...`).
- Timestamps in agent envelopes are now UTC (compact `YYYY-MM-DDTHH:mmZ`); removed `messages.timestampPrefix`. Add `agent.userTimezone` to tell the model the user’s local time (system prompt only).
- Model config schema changes (auth profiles + model lists); doctor auto-migrates and the gateway rewrites legacy configs on startup.
- Commands: gate all slash commands to authorized senders; add `/compact` to manually compact session context.
- Groups: `whatsapp.groups`, `telegram.groups`, and `imessage.groups` now act as allowlists when set. Add `"*"` to keep allow-all behavior.

### Fixes
- Build: import tool-display JSON as a module instead of runtime file reads. Thanks @mukhtharcm for PR #312.
- Messages: stop defaulting ack reactions to 👀 when identity emoji is missing.
- Auto-reply: require slash for control commands to avoid false triggers in normal text.
- Auto-reply: treat steer during compaction as a follow-up, queued until compaction completes.
- Auth: lock auth profile refreshes to avoid multi-instance OAuth logouts; keep credentials on refresh failure.
- Gateway/CLI: stop forcing localhost URL in remote mode so remote gateway config works. Thanks @oswalpalash for PR #293.
- Onboarding: prompt immediately for OpenAI Codex redirect URL on remote/headless logins.
- Configure: add OpenAI Codex (ChatGPT OAuth) auth choice (align with onboarding).
- Doctor: suggest adding the workspace memory system when missing (opt-out via `--no-workspace-suggestions`).
- Build: fix duplicate protocol export, align Codex OAuth options, and add proper-lockfile typings.
- Build: install Bun in the Dockerfile so `pnpm build` can run Bun scripts. Thanks @loukotal for PR #284.
- Typing indicators: stop typing once the reply dispatcher drains to prevent stuck typing across Discord/Telegram/WhatsApp.
- Typing indicators: fix a race that could keep the typing indicator stuck after quick replies. Thanks @thewilloftheshadow for PR #270.
- Google: merge consecutive messages to satisfy strict role alternation for Google provider models. Thanks @Asleep123 for PR #266.
- Postinstall: handle targetDir symlinks in the install script. Thanks @obviyus for PR #272.
- WhatsApp/Telegram: add groupPolicy handling for group messages and normalize allowFrom matching (tg/telegram prefixes). Thanks @mneves75.
- Auto-reply: add configurable ack reactions for inbound messages (default 👀 or `identity.emoji`) with scope controls. Thanks @obviyus for PR #178.
- Polls: unify WhatsApp + Discord poll sends via the gateway + CLI (`clawdbot poll`). (#123) — thanks @dbhurley
- Onboarding: resolve CLI entrypoint when running via `npx` so gateway daemon install works without a build step.
- Onboarding: when OpenAI Codex OAuth is used, default to `openai-codex/gpt-5.2` and warn if the selected model lacks auth.
- CLI: auto-migrate legacy config entries on command start (same behavior as gateway startup).
- Gateway: add `gateway stop|restart` helpers and surface launchd/systemd/schtasks stop hints when the gateway is already running.
- Gateway: honor `agent.timeoutSeconds` for `chat.send` and share timeout defaults across chat/cron/auto-reply. Thanks @MSch for PR #229.
- Auth: prioritize OAuth profiles but fall back to API keys when refresh fails; stored profiles now load without explicit auth order.
- Control UI: harden config Form view with schema normalization, map editing, and guardrails to prevent data loss on save.
- Cron: normalize cron.add/update inputs, align channel enums/status fields across gateway/CLI/UI/macOS, and add protocol conformance tests. Thanks @mneves75 for PR #256.
- Docs: add group chat participation guidance to the AGENTS template.
- Gmail: stop restart loop when `gog gmail watch serve` fails to bind (address already in use).
- Linux: auto-attempt lingering during onboarding (try without sudo, fallback to sudo) and prompt on install/restart to keep the gateway alive after logout/idle. Thanks @tobiasbischoff for PR #237.
- TUI: migrate key handling to the updated pi-tui Key matcher API.
- TUI: add `/elev` alias for `/elevated`.
- Logging: redact sensitive tokens in verbose tool summaries by default (configurable patterns).
- macOS: prefer gateway config reads/writes in local mode (fall back to disk if the gateway is unavailable).
- macOS: local gateway now connects via tailnet IP when bind mode is `tailnet`/`auto`.
- macOS: Connections settings now use a custom sidebar to avoid toolbar toggle issues, with rounded styling and full-width row hit targets.
- macOS: drop deprecated `afterMs` from agent wait params to match gateway schema.
- Auth: add OpenAI Codex OAuth support and migrate legacy oauth.json into auth.json.
- Model: `/model` list shows auth source (masked key or OAuth email) per provider.
- Model: `/model list` is an alias for `/model`.
- Model: `/model` output now includes auth source location (env/auth.json/models.json).
- Model: avoid duplicate `missing (missing)` auth labels in `/model` list output.
- Auth: when `openai` has no API key but Codex OAuth exists, suggest `openai-codex/gpt-5.2` vs `OPENAI_API_KEY`.
- Docs: clarify auth storage, migration, and OpenAI Codex OAuth onboarding.
- Sandbox: copy inbound media into sandbox workspaces so agent tools can read attachments.
- Sandbox: enable session tools in sandboxed sessions with spawned-only visibility by default (opt-in `agent.sandbox.sessionToolsVisibility = "all"`).
- Control UI: show a reading indicator bubble while the assistant is responding.
- Control UI: animate reading indicator dots (honors reduced-motion).
- Control UI: stabilize chat streaming during tool runs (no flicker/vanishing text; correct run scoping).
- Control UI: let config-form enums select empty-string values. Thanks @sreekaransrinath for PR #268.
- Control UI: scroll chat to bottom on initial load. Thanks @kiranjd for PR #274.
- Control UI: add Chat focus mode toggle to collapse header + sidebar.
- Control UI: standardize UI build instructions on `bun run ui:*` (fallback supported).
- Status: show runtime (docker/direct) and move shortcuts to `/help`.
- Status: show model auth source (api-key/oauth).
- Block streaming: avoid splitting Markdown fenced blocks and reopen fences when forced to split.
- Block streaming: preserve leading indentation in block replies (lists, indented fences).
- Docs: document systemd lingering and logged-in session requirements on macOS/Windows.
- Auto-reply: centralize tool/block/final dispatch across providers for consistent streaming + heartbeat/prefix handling. Thanks @MSch for PR #225.
- Heartbeat: make HEARTBEAT_OK ack padding configurable across heartbeat and cron delivery. (#238) — thanks @jalehman
- Skills: emit MEDIA token after Nano Banana Pro image generation. Thanks @Iamadig for PR #271.
- WhatsApp: set sender E.164 for direct chats so owner commands work in DMs.
- Slack: keep auto-replies in the original thread when responding to thread messages. Thanks @scald for PR #251.
- Slack: fix Slack provider startup under Bun by using a named import for Bolt `App`. Thanks @snopoke for PR #299.
- Discord: surface missing-permission hints (muted/role overrides) when replies fail.
- Discord: use channel IDs for DMs instead of user IDs. Thanks @VACInc for PR #261.
- Docs: clarify Slack manifest scopes (current vs optional) with references. Thanks @jarvis-medmatic for PR #235.
- Control UI: avoid Slack config ReferenceError by reading slack config snapshots. Thanks @sreekaransrinath for PR #249.
- Auth: rotate across multiple OAuth profiles with cooldown tracking and email-based profile IDs. Thanks @mukhtharcm for PR #269.
- Auth: fix multi-account OAuth rotation so round-robin alternates instead of pinning to lastGood. Thanks @mukhtharcm for PR #281.
- Configure: stop auto-writing `auth.order` for newly added auth profiles (round-robin default unless explicitly pinned).
- Telegram: honor routing.groupChat.mentionPatterns for group mention gating. Thanks Kevin Kern (@regenrek) for PR #242.
- Telegram: gate groups via `telegram.groups` allowlist (align with WhatsApp/iMessage). Thanks @kitze for PR #241.
- Telegram: support media groups (multi-image messages). Thanks @obviyus for PR #220.
- Telegram/WhatsApp: parse shared locations (pins, places, live) and expose structured ctx fields. Thanks @nachoiacovino for PR #194.
- Auto-reply: block unauthorized `/reset` and infer WhatsApp senders from E.164 inputs.
- Auto-reply: track compaction count in session status; verbose mode announces auto-compactions.
- Telegram: notify users when inbound media exceeds size limits. Thanks @jarvis-medmatic for PR #283.
- Telegram: send GIF media as animations (auto-play) and improve filename sniffing.
- Bash tool: inherit gateway PATH so Nix-provided tools resolve during commands. Thanks @joshp123 for PR #202.

### Maintenance
- UI: add favicon.ico derived from the macOS app icon. Thanks @jeffersonwarrior for PR #305.
- Tooling: replace tsx with bun for TypeScript execution. Thanks @obviyus for PR #278.
- Deps: bump pi-* stack, Slack SDK, discord-api-types, file-type, zod, and Biome.
- Skills: add CodexBar model usage helper with macOS requirement metadata.
- Skills: add 1Password CLI skill with op examples.
- Lint: organize imports and wrap long lines in reply commands.
- Refactor: centralize group allowlist/mention policy across providers.
- Deps: update to latest across the repo.

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
- Bun: optional local install/build workflow without maintaining a Bun lockfile (see `docs/bun.md`).

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
- Onboarding: when running from source, auto-build missing Control UI assets (`bun run ui:build`).
- Discord/Slack: route reaction + system notifications to the correct session (no main-session bleed).
- Agent tools: honor `agent.tools` allow/deny policy even when sandbox is off.
- Discord: avoid duplicate replies when OpenAI emits repeated `message_end` events.
- Commands: unify /status (inline) and command auth across providers; group bypass for authorized control commands; remove Discord /clawd slash handler.
- CLI: run `clawdbot agent` via the Gateway by default; use `--local` to force embedded mode.

## 2026.1.5

### Fixes
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
