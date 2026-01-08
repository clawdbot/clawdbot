# Changelog

**Why this looks different:** the project was renamed from **Clawdis → Clawdbot**. To make the transition clear, releases now use **date-based versions** (`YYYY.M.D`) and the changelog is **compressed** into milestone summaries. Full detail still lives in git history and the docs.

## Unreleased

### Breaking
- **SECURITY (update ASAP):** inbound DMs are now **locked down by default** on Telegram/WhatsApp/Signal/iMessage/Discord/Slack.
  - Previously, if you didn’t configure an allowlist, your bot could be **open to anyone** (especially discoverable Telegram bots).
  - New default: DM pairing (`dmPolicy="pairing"` / `discord.dm.policy="pairing"` / `slack.dm.policy="pairing"`).
  - To keep old “open to everyone” behavior: set `dmPolicy="open"` and include `"*"` in the relevant `allowFrom` (Discord/Slack: `discord.dm.allowFrom` / `slack.dm.allowFrom`).
  - Approve requests via `clawdbot pairing list --provider <provider>` + `clawdbot pairing approve --provider <provider> <code>` (Telegram also supports `clawdbot telegram pairing ...`).
- Sandbox: default `agent.sandbox.scope` to `"agent"` (one container/workspace per agent). Use `"session"` for per-session isolation; `"shared"` disables cross-session isolation.
- Timestamps in agent envelopes are now UTC (compact `YYYY-MM-DDTHH:mmZ`); removed `messages.timestampPrefix`. Add `agent.userTimezone` to tell the model the user’s local time (system prompt only).
- Model config schema changes (auth profiles + model lists); doctor auto-migrates and the gateway rewrites legacy configs on startup.
- Commands: gate all slash commands to authorized senders; add `/compact` to manually compact session context.
- Groups: `whatsapp.groups`, `telegram.groups`, and `imessage.groups` now act as allowlists when set. Add `"*"` to keep allow-all behavior.
- Auto-reply: removed `autoReply` from Discord/Slack/Telegram channel configs; use `requireMention` instead (Telegram topics now support `requireMention` overrides).

### Fixes
- Doctor/Daemon: surface gateway runtime state + port collision diagnostics; warn on legacy workspace dirs.
- Discord: format slow listener logs in seconds to match shared duration style.
- CLI: show colored table output for `clawdbot cron list` (JSON behind `--json`).
- CLI: add cron `create`/`remove`/`delete` aliases for job management.
- Agent: avoid duplicating context/skills when SDK rebuilds the system prompt. (#418)
- Agent: replace SDK base system prompt with ClaudeBot prompt, add skills guidance, and document the layout.
- Signal: reconnect SSE monitor with abortable backoff; log stream errors. Thanks @nexty5870 for PR #430.
- Gateway: pass resolved provider as messageProvider for agent runs so provider-specific tools are available. Thanks @imfing for PR #389.
- Doctor: add state integrity checks + repair prompts for missing sessions/state dirs, transcript mismatches, and permission issues; document full doctor flow and workspace backup tips.
- Discord/Telegram: add per-request retry policy with configurable delays and docs.
- Telegram: run long polling via grammY runner with per-chat sequentialization and concurrency tied to `agent.maxConcurrent`. Thanks @mukhtharcm for PR #366.
- macOS: prevent gateway launchd startup race where the app could kill a just-started gateway; avoid unnecessary `bootout` and ensure the job is enabled at login. Fixes #306. Thanks @gupsammy for PR #387.
- macOS: ignore ciao announcement cancellation rejections during Bonjour shutdown to avoid unhandled exits. Thanks @emanuelst for PR #419.
- Pairing: generate DM pairing codes with CSPRNG, expire pending codes after 1 hour, and avoid re-sending codes for already pending requests.
- Pairing: lock + atomically write pairing stores with 0600 perms and stop logging pairing codes in provider logs.
- WhatsApp: add self-phone mode (no pairing replies for outbound DMs) and onboarding prompt for personal vs separate numbers (auto allowlist + response prefix for personal).
- Discord: include all inbound attachments in `MediaPaths`/`MediaUrls` (back-compat `MediaPath`/`MediaUrl` still first).
- Sandbox: add `agent.sandbox.workspaceAccess` (`none`/`ro`/`rw`) to control agent workspace visibility inside the container; `ro` hard-disables `write`/`edit`.
- Telegram: default `replyToMode` to `"first"`, add forum topic reply threading for tool sends, and update Telegram docs. Thanks @mneves75 for PR #326.
- Agent: suppress duplicate messaging tool confirmations and honor per-provider reply threading in auto-replies. Thanks @mneves75 for PR #326.
- Routing: allow per-agent sandbox overrides (including `workspaceAccess` and `sandbox.tools`) plus per-agent tool policies in multi-agent configs. Thanks @pasogott for PR #380.
- Sandbox: allow per-agent `routing.agents.<agentId>.sandbox.{docker,browser,prune}.*` overrides for multi-agent gateways (ignored when `scope: "shared"`).
- Tools: make per-agent tool policies override global defaults and run bash synchronously when `process` is disallowed.
- Tools: scope `process` sessions per agent to prevent cross-agent visibility.
- Cron: clamp timer delay to avoid TimeoutOverflowWarning. Thanks @emanuelst for PR #412.
- Web UI: allow reconnect + password URL auth for the control UI and always scrub auth params from the URL. Thanks @oswalpalash for PR #414.
- Web UI: add Connect button on Overview to apply connection changes. Thanks @wizaj for PR #385.
- ClawdbotKit: fix SwiftPM resource bundling path for `tool-display.json`. Thanks @fcatuhe for PR #398.
- Tools: add Telegram/WhatsApp reaction tools (with per-provider gating). Thanks @zats for PR #353.
- Tools: flatten literal-union schemas for Claude on Vertex AI. Thanks @carlulsoe for PR #409.
- Tools: keep tool failure logs concise (no stack traces); full stack only in debug logs.
- Tools: add nodes tool run invoke-timeout support. Thanks @sircrumpet for PR #433.
- Tools: unify reaction removal semantics across Discord/Slack/Telegram/WhatsApp and allow WhatsApp reaction routing across accounts.
- Android: fix APK output filename renaming after AGP updates. Thanks @Syhids for PR #410.
- Android: rotate camera photos by EXIF orientation. Thanks @fcatuhe for PR #403.
- Gateway/CLI: add daemon runtime selection (Node recommended; Bun optional) and document WhatsApp/Baileys Bun WebSocket instability on reconnect.
- CLI: add `clawdbot docs` live docs search with pretty output.
- CLI: add `clawdbot agents` (list/add/delete) with wizarded workspace/setup, provider login, and full prune on delete.
- Discord/Slack: fork thread sessions (agent-scoped) and inject thread starters for context. Thanks @thewilloftheshadow for PR #400.
- Agent: treat compaction retry AbortError as a fallback trigger without swallowing non-abort errors. Thanks @erikpr1994 for PR #341.
- Agent: add opt-in session pruning for tool results to reduce context bloat. Thanks @maxsumrall for PR #381.
- Agent: protect bootstrap prefix from context pruning. Thanks @maxsumrall for PR #381.
- Agent: deliver final replies for non-streaming models when block chunking is enabled. Thank you @mneves75 for PR #369!
- Agent: trim bootstrap context injections and keep group guidance concise (emoji reactions allowed). Thanks @tobiasbischoff for PR #370.
- Agent: return a friendly context overflow response (413/request_too_large). Thanks @alejandroOPI for PR #395.
- Sub-agents: allow `sessions_spawn` model overrides and error on invalid models. Thanks @azade-c for PR #298.
- Sub-agents: skip invalid model overrides with a warning and keep the run alive; tool exceptions now return tool errors instead of crashing the agent.
- Sessions: forward explicit sessionKey through gateway/chat/node bridge to avoid sub-agent sessionId mixups.
- Heartbeat: default interval 30m; clarified default prompt usage and HEARTBEAT.md template behavior.
- Onboarding: write auth profiles to the multi-agent path (`~/.clawdbot/agents/main/agent/`) so the gateway finds credentials on first startup. Thanks @minghinmatthewlam for PR #327.
- Docs: add missing `ui:install` setup step in the README. Thanks @hugobarauna for PR #300.
- Docs: sanitize AGENTS guidance and add Clawdis migration troubleshooting note. Thanks @buddyh for PR #348.
- Docs: add ClawdHub guide and hubs link for browsing, install, and sync workflows.
- Docs: add FAQ for PNPM/Bun lockfile migration warning; link AgentSkills spec + ClawdHub guide (`/clawdhub`) from skills docs.
- Docs: add showcase projects (xuezh, gohome, roborock, padel-cli). Thanks @joshp123.
- Build: import tool-display JSON as a module instead of runtime file reads. Thanks @mukhtharcm for PR #312.
- Status: add provider usage snapshots to `/status`, `clawdbot status --usage`, and the macOS menu bar.
- Build: fix macOS packaging QR smoke test for the bun-compiled relay. Thanks @dbhurley for PR #358.
- Browser: fix `browser snapshot`/`browser act` timeouts under Bun by patching Playwright’s CDP WebSocket selection. Thanks @azade-c for PR #307.
- Browser: add `--browser-profile` flag and honor profile in tabs routes + browser tool. Thanks @jamesgroat for PR #324.
- Gmail: include tailscale command exit codes/output when hook setup fails (easier debugging).
- Telegram: stop typing after tool results. Thanks @AbhisekBasu1 for PR #322.
- Telegram: include sender identity in group envelope headers. (#336)
- Telegram: support forum topics with topic-isolated sessions and message_thread_id routing. Thanks @HazAT, @nachoiacovino, @RandyVentures for PR #321/#333/#334.
- Telegram: add draft streaming via `sendMessageDraft` with `telegram.streamMode`, plus `/reasoning stream` for draft-only reasoning.
- Telegram: honor `/activation` session mode for group mention gating and clarify group activation docs. Thanks @julianengel for PR #377.
- Telegram: isolate forum topic transcripts per thread and validate Gemini turn ordering in multi-topic sessions. Thanks @hsrvc for PR #407.
- iMessage: ignore disconnect errors during shutdown (avoid unhandled promise rejections). Thanks @antons for PR #359.
- Messages: stop defaulting ack reactions to 👀 when identity emoji is missing.
- Auto-reply: require slash for control commands to avoid false triggers in normal text.
- Auto-reply: add `/reasoning on|off` to expose model reasoning blocks (italic).
- Auto-reply: place reasoning blocks before the final reply text when appended.
- Auto-reply: flag error payloads and improve Bun socket error messaging. Thanks @emanuelst for PR #331.
- Auto-reply: add per-channel/topic skill filters + system prompts for Discord/Slack/Telegram. Thanks @kitze for PR #286.
- Auto-reply: refresh `/status` output with build info, compact context, and queue depth.
- Commands: add `/stop` to the registry and route native aborts to the active chat session. Thanks @nachoiacovino for PR #295.
- Commands: allow `/<alias>` shorthand for `/model` using `agent.models.*.alias`, without shadowing built-ins. Thanks @azade-c for PR #393.
- Commands: unify native + text chat commands behind `commands.*` config (Discord/Slack/Telegram). Thanks @thewilloftheshadow for PR #275.
- Auto-reply: treat steer during compaction as a follow-up, queued until compaction completes.
- Auth: lock auth profile refreshes to avoid multi-instance OAuth logouts; keep credentials on refresh failure.
- Auth/Doctor: migrate Anthropic OAuth configs from `anthropic:default` → `anthropic:<email>` and surface a doctor hint on refresh failures. Thanks @RandyVentures for PR #361. (#363)
- Auth: delete legacy `auth.json` after migration to prevent stale OAuth token overwrites. Thanks @reeltimeapps for PR #368.
- Auth: auto-sync OAuth creds from Claude CLI/Codex CLI into `anthropic:claude-cli`/`openai-codex:codex-cli` and offer them as onboarding/config choices (avoids `refresh_token_reused`). Thanks @pepicrft for PR #374.
- Gateway/CLI: stop forcing localhost URL in remote mode so remote gateway config works. Thanks @oswalpalash for PR #293.
- Onboarding: prompt immediately for OpenAI Codex redirect URL on remote/headless logins.
- Configure: add OpenAI Codex (ChatGPT OAuth) auth choice (align with onboarding).
- Doctor: suggest adding the workspace memory system when missing (opt-out via `--no-workspace-suggestions`).
- Doctor: normalize default workspace path to `~/clawd` (avoid `~/clawdbot`).
- Doctor: add `--yes` and `--non-interactive` for headless/automation runs (`--non-interactive` only applies safe migrations).
- Doctor/CLI: scan for extra gateway-like services (optional `--deep`) and show cleanup hints.
- Gateway/CLI: auto-migrate legacy sessions + agent state layouts on startup (safe; WhatsApp auth still requires `clawdbot doctor`).
- Workspace: only create `BOOTSTRAP.md` for brand-new workspaces (don’t recreate after deletion).
- Build: fix duplicate protocol export, align Codex OAuth options, and add proper-lockfile typings.
- Build: install Bun in the Dockerfile so `pnpm build` can run Bun scripts. Thanks @loukotal for PR #284.
- Typing indicators: stop typing once the reply dispatcher drains to prevent stuck typing across Discord/Telegram/WhatsApp.
- Typing indicators: fix a race that could keep the typing indicator stuck after quick replies. Thanks @thewilloftheshadow for PR #270.
- Google: merge consecutive messages to satisfy strict role alternation for Google provider models. Thanks @Asleep123 for PR #266.
- Postinstall: handle targetDir symlinks in the install script. Thanks @obviyus for PR #272.
- Status: show configured model in `/status` (override-aware). Thanks @azade-c for PR #396.
- WhatsApp/Telegram: add groupPolicy handling for group messages and normalize allowFrom matching (tg/telegram prefixes). Thanks @mneves75.
- Auto-reply: add configurable ack reactions for inbound messages (default 👀 or `identity.emoji`) with scope controls. Thanks @obviyus for PR #178.
- Polls: unify WhatsApp + Discord poll sends via the gateway + CLI (`clawdbot poll`). (#123) — thanks @dbhurley
- Onboarding: resolve CLI entrypoint when running via `npx` so gateway daemon install works without a build step.
- Onboarding: when OpenAI Codex OAuth is used, default to `openai-codex/gpt-5.2` and warn if the selected model lacks auth.
- CLI: auto-migrate legacy config entries on command start (same behavior as gateway startup).
- Gateway: add `gateway stop|restart` helpers and surface launchd/systemd/schtasks stop hints when the gateway is already running.
- Cron/Heartbeat: enqueue cron system events in the resolved main session so heartbeats drain the right queue. Thanks @zats for PR #350.
- Gateway: honor `agent.timeoutSeconds` for `chat.send` and share timeout defaults across chat/cron/auto-reply. Thanks @MSch for PR #229.
- Auth: prioritize OAuth profiles but fall back to API keys when refresh fails; stored profiles now load without explicit auth order.
- Auth/CLI: normalize provider ids and Z.AI aliases across auth profile ordering and models list/status. Thanks @mneves75 for PR #303.
- Control UI: harden config Form view with schema normalization, map editing, and guardrails to prevent data loss on save.
- Cron: normalize cron.add/update inputs, align channel enums/status fields across gateway/CLI/UI/macOS, and add protocol conformance tests. Thanks @mneves75 for PR #256.
- Docs: add group chat participation guidance to the AGENTS template.
- Gmail: stop restart loop when `gog gmail watch serve` fails to bind (address already in use).
- Linux: auto-attempt lingering during onboarding (try without sudo, fallback to sudo) and prompt on install/restart to keep the gateway alive after logout/idle. Thanks @tobiasbischoff for PR #237.
- Skills: add Linuxbrew paths to gateway PATH bootstrap so the Skills UI can run brew installers under systemd/minimal environments.
- TUI: migrate key handling to the updated pi-tui Key matcher API.
- TUI: add `/elev` alias for `/elevated`.
- Logging: redact sensitive tokens in verbose tool summaries by default (configurable patterns).
- macOS: keep app connection settings local in remote mode to avoid overwriting gateway config. Thanks @ngutman for PR #310.
- macOS: honor discovered gateway ports (Bonjour TXT) so remote tunnels connect to the right ports. Thanks @kkarimi for PR #375.
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
- Docs: clarify per-session sandbox isolation and `perSession` sharing risks.
- Sandbox: copy inbound media into sandbox workspaces so agent tools can read attachments.
- Sandbox: enable session tools in sandboxed sessions with spawned-only visibility by default (opt-in `agent.sandbox.sessionToolsVisibility = "all"`).
- Control UI: show a reading indicator bubble while the assistant is responding.
- Control UI: animate reading indicator dots (honors reduced-motion).
- Control UI: stabilize chat streaming during tool runs (no flicker/vanishing text; correct run scoping).
- Google: recover from corrupted transcripts that start with an assistant tool call to avoid Cloud Code Assist 400 ordering errors. Thanks @jonasjancarik for PR #421. (#406)
- Control UI: let config-form enums select empty-string values. Thanks @sreekaransrinath for PR #268.
- Control UI: scroll chat to bottom on initial load. Thanks @kiranjd for PR #274.
- Control UI: add Chat focus mode toggle to collapse header + sidebar.
- Control UI: tighten focus mode spacing (reduce top padding, add comfortable compose inset).
- Control UI: standardize UI build instructions on `bun run ui:*` (fallback supported).
- Status: show runtime (docker/direct) and move shortcuts to `/help`.
- Status: show model auth source (api-key/oauth).
- Status: fix zero token counters for Anthropic (Opus) sessions by normalizing usage fields and ignoring empty usage updates.
- Block streaming: avoid splitting Markdown fenced blocks and reopen fences when forced to split.
- Block streaming: preserve leading indentation in block replies (lists, indented fences).
- Docs: document systemd lingering and logged-in session requirements on macOS/Windows.
- Auto-reply: centralize tool/block/final dispatch across providers for consistent streaming + heartbeat/prefix handling. Thanks @MSch for PR #225.
- Routing: route replies back to the originating provider/chat when multiple providers share the same session. Thanks @jalehman for PR #328.
- Heartbeat: make HEARTBEAT_OK ack padding configurable across heartbeat and cron delivery. (#238) — thanks @jalehman
- Skills: emit MEDIA token after Nano Banana Pro image generation. Thanks @Iamadig for PR #271.
- WhatsApp: set sender E.164 for direct chats so owner commands work in DMs.
- Slack: keep auto-replies in the original thread when responding to thread messages. Thanks @scald for PR #251.
- Slack: send typing status updates via assistant threads. Thanks @thewilloftheshadow for PR #320.
- Slack: fix Slack provider startup under Bun by using a named import for Bolt `App`. Thanks @snopoke for PR #299.
- Discord: surface missing-permission hints (muted/role overrides) when replies fail.
- Discord: use channel IDs for DMs instead of user IDs. Thanks @VACInc for PR #261.
- Discord: treat empty message content as media placeholder so voice messages are not dropped; enables `routing.transcribeAudio`. Thanks @VACInc for PR #339.
- Docs: clarify Slack manifest scopes (current vs optional) with references. Thanks @jarvis-medmatic for PR #235.
- Control UI: avoid Slack config ReferenceError by reading slack config snapshots. Thanks @sreekaransrinath for PR #249.
- Auth: rotate across multiple OAuth profiles with cooldown tracking and email-based profile IDs. Thanks @mukhtharcm for PR #269.
- Auth: fix multi-account OAuth rotation so round-robin alternates instead of pinning to lastGood. Thanks @mukhtharcm for PR #281.
- Auth: lock auth profile usage updates and fail fast on 429s during rotation. Thanks @mukhtharcm for PR #342.
- Configure: stop auto-writing `auth.order` for newly added auth profiles (round-robin default unless explicitly pinned).
- Telegram: honor routing.groupChat.mentionPatterns for group mention gating. Thanks Kevin Kern (@regenrek) for PR #242.
- Telegram: gate groups via `telegram.groups` allowlist (align with WhatsApp/iMessage). Thanks @kitze for PR #241.
- Telegram: support media groups (multi-image messages). Thanks @obviyus for PR #220.
- Telegram/WhatsApp: parse shared locations (pins, places, live) and expose structured ctx fields. Thanks @nachoiacovino for PR #194.
- Auto-reply: block unauthorized `/reset` and infer WhatsApp senders from E.164 inputs.
- Auto-reply: reset corrupted Gemini sessions when function-call ordering breaks. Thanks @VACInc for PR #297.
- Auto-reply: track compaction count in session status; verbose mode announces auto-compactions.
- Telegram: notify users when inbound media exceeds size limits. Thanks @jarvis-medmatic for PR #283.
- Telegram: send GIF media as animations (auto-play) and improve filename sniffing.
- Bash tool: inherit gateway PATH so Nix-provided tools resolve during commands. Thanks @joshp123 for PR #202.
- Delivery chunking: keep Markdown fenced code blocks valid when splitting long replies (close + reopen fences).
- Auth: prefer OAuth profiles over API keys during round-robin selection (prevents OAuth “lost after one message” when both are configured).
- Models: extend `clawdbot models` status output with a masked auth overview (profiles, env sources, and OAuth counts).

### Maintenance
- Skills: add Himalaya email CLI skill. Thanks @dantelex for PR #335.
- Agent: add `skipBootstrap` config option. Thanks @onutc for PR #292.
- UI: add favicon.ico derived from the macOS app icon. Thanks @jeffersonwarrior for PR #305.
- Tooling: replace tsx with bun for TypeScript execution. Thanks @obviyus for PR #278.
- Deps: bump pi-* stack, Slack SDK, discord-api-types, file-type, zod, and Biome.
- Skills: add CodexBar model usage helper with macOS requirement metadata.
- Skills: add 1Password CLI skill with op examples.
- Lint: organize imports and wrap long lines in reply commands.
- Refactor: centralize group allowlist/mention policy across providers.
- Deps: update to latest across the repo.

## 2026.1.7

### Fixes
- Android: bump version to 2026.1.7, add version code, and name APK outputs. Thanks @fcatuhe for PR #402.

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
