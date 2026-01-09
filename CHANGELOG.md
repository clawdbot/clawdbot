# Changelog

## Unreleased

- macOS: add node bridge heartbeat pings to detect half-open sockets and reconnect cleanly. (#572) — thanks @ngutman
- Node bridge: harden keepalive + heartbeat handling (TCP keepalive, better disconnects, and keepalive config tests). (#577) — thanks @steipete
- Control UI: improve mobile responsiveness. (#558) — thanks @carlulsoe
- CLI: add `sandbox list` and `sandbox recreate` commands for managing Docker sandbox containers after image/config updates. (#563) — thanks @pasogott
- Providers: add Microsoft Teams provider with polling, attachments, and CLI send support. (#404) — thanks @onutc
- Slack: honor reply tags + replyToMode while keeping threaded replies in-thread. (#574) — thanks @bolismauro
- Discord: avoid category parent overrides for channel allowlists and refactor thread context helpers. (#588) — thanks @steipete
- Discord: fix forum thread starters and cache channel lookups for thread context. (#585) — thanks @thewilloftheshadow
- Commands: accept /models as an alias for /model.
- Commands: add `/usage` as an alias for `/status`. (#492) — thanks @lc0rp
- Commands: harden slash command registry and list text-only commands in `/commands`.
- Models/Auth: show per-agent auth candidates in `/model status`, and add `clawdbot models auth order {get,set,clear}` (per-agent auth rotation overrides). — thanks @steipete
- Debugging: add raw model stream logging flags and document gateway watch mode.
- Gateway: decode dns-sd escaped UTF-8 in discovery output and show scan progress immediately. — thanks @steipete
- Agent: add claude-cli/opus-4.5 runner via Claude CLI with resume support (tools disabled).
- CLI: move `clawdbot message` to subcommands (`message send|poll|…`), fold Discord/Slack/Telegram/WhatsApp tools into `message`, and require `--provider` unless only one provider is configured.
- CLI: improve `logs` output (pretty/plain/JSONL), add gateway unreachable hint, and document logging.
- Hooks: default hook agent delivery to true. (#533) — thanks @mcinteerj
- Hooks: normalize hook agent providers (aliases + msteams support).
- WhatsApp: route queued replies to the original sender instead of the bot's own number. (#534) — thanks @mcinteerj
- Models: add OAuth expiry checks in doctor, expanded `models status` auth output (missing auth + `--check` exit codes). (#538) — thanks @latitudeki5223
- Deps: bump Pi to 0.40.0 and drop pi-ai patch (upstream 429 fix). (#543) — thanks @mcinteerj
- Security: per-agent mention patterns and group elevated directives now require explicit mention to avoid cross-agent toggles.
- Config: support inline env vars in config (`env.*` / `env.vars`) and document env precedence.
- Agent: enable adaptive context pruning by default for tool-result trimming.
- Doctor: check config/state permissions and offer to tighten them. — thanks @steipete
- Doctor/Daemon: audit supervisor configs, add --repair/--force flows, surface service config audits in daemon status, and document user vs system services. — thanks @steipete
- Doctor: repair gateway service entrypoint when switching between npm and git installs; add Docker e2e coverage. — thanks @steipete
- Daemon: align generated systemd unit with docs for network-online + restart delay. (#479) — thanks @azade-c
- Daemon: add KillMode=process to systemd units to avoid podman restart hangs. (#541) — thanks @ogulcancelik
- Doctor: run legacy state migrations in non-interactive mode without prompts.
- Cron: parse Telegram topic targets for isolated delivery. (#478) — thanks @nachoiacovino
- Outbound: default Telegram account selection for config-only tokens; remove heartbeat-specific accountId handling. (follow-up #516) — thanks @YuriNachos
- Cron: allow Telegram delivery targets with topic/thread IDs (e.g. `-100…:topic:123`). (#474) — thanks @mitschabaude-bot
- Heartbeat: resolve Telegram account IDs from config-only tokens; cron tool accepts canonical `jobId` and legacy `id` for job actions. (#516) — thanks @YuriNachos
- Discord: stop provider when gateway reconnects are exhausted and surface errors. (#514) — thanks @joshp123
- Agents: strip empty assistant text blocks from session history to avoid Claude API 400s. (#210)
- Agents: scrub unsupported JSON Schema keywords from tool schemas for Cloud Code Assist API compatibility. (#567) — thanks @erikpr1994
- Auto-reply: preserve block reply ordering with timeout fallback for streaming. (#503) — thanks @joshp123
- Auto-reply: block reply ordering fix (duplicate PR superseded by #503). (#483) — thanks @AbhisekBasu1
- Auto-reply: avoid splitting outbound chunks inside parentheses. (#499) — thanks @philipp-spiess
- Auto-reply: preserve spacing when stripping inline directives. (#539) — thanks @joshp123
- Auto-reply: relax reply tag parsing to allow whitespace. (#560) — thanks @mcinteerj
- Auto-reply: fix /status usage summary filtering for the active provider.
- Status: show provider prefix in /status model display. (#506) — thanks @mcinteerj
- Status: compact /status with session token usage + estimated cost, add `/cost` per-response usage lines (tokens-only for OAuth).
- Status: show active auth profile and key snippet in /status.
- Status: show provider usage windows when auth uses token-based OAuth (e.g. Claude setup-token).
- Agent: promote `<think>`/`<thinking>` tag reasoning into structured thinking blocks so `/reasoning` works consistently for OpenAI-compat providers.
- macOS: package ClawdbotKit resources and Swift 6.2 compatibility dylib to avoid launch/tool crashes. (#473) — thanks @gupsammy
- WhatsApp: group `/model list` output by provider for scannability. (#456) - thanks @mcinteerj
- Hooks: allow per-hook model overrides for webhook/Gmail runs (e.g. GPT 5 Mini).
- Control UI: logs tab opens at the newest entries (bottom).
- Control UI: default to relative paths for control UI assets. (#569) — thanks @bjesuiter
- Control UI: add Docs link, remove chat composer divider, and add New session button.
- Control UI: link sessions list to chat view. (#471) — thanks @HazAT
- Sessions: support session `label` in store/list/UI and allow `sessions_send` lookup by label. (#570) — thanks @azade-c
- Control UI: show/patch per-session reasoning level and render extracted reasoning in chat.
- Control UI: queue outgoing chat messages, add Enter-to-send, and show queued items. (#527) — thanks @YuriNachos
- Control UI: drop explicit `ui:install` step; `ui:build` now auto-installs UI deps (docs + update flow).
- Telegram: retry long-polling conflicts with backoff to avoid fatal exits.
- Telegram: fix grammY fetch type mismatch when injecting `fetch`. (#512) — thanks @YuriNachos
- WhatsApp: resolve @lid JIDs via Baileys mapping to unblock inbound messages. (#415)
- Pairing: replies now include sender ids for Discord/Slack/Signal/iMessage/WhatsApp; pairing list labels them explicitly.
- Messages: default inbound/outbound prefixes from the routed agent’s `identity.name` when set. (#578) — thanks @p6l-richard
- Signal: accept UUID-only senders for pairing/allowlists/routing when sourceNumber is missing. (#523) — thanks @neist
- Agent system prompt: avoid automatic self-updates unless explicitly requested.
- Onboarding: tighten QuickStart hint copy for configuring later.
- Onboarding: set Gemini 3 Pro as the default model for Gemini API key auth. (#489) — thanks @jonasjancarik
- Onboarding: avoid “token expired” for Codex CLI when expiry is heuristic.
- Onboarding: QuickStart jumps straight into provider selection with Telegram preselected when unset.
- Onboarding: QuickStart auto-installs the Gateway daemon with Node (no runtime picker).
- Onboarding: clarify WhatsApp owner number prompt and label pairing phone number.
- Auto-reply: normalize routed replies to drop NO_REPLY and apply response prefixes.
- Commands: add /debug for runtime config overrides (memory-only).
- Daemon runtime: remove Bun from selection options.
- CLI: restore hidden `gateway-daemon` alias for legacy launchd configs.
- Onboarding/Configure: add OpenAI API key flow that stores in shared `~/.clawdbot/.env` for launchd; simplify Anthropic token prompt order.
- Configure/Onboarding: show Control UI docs with gateway reachability status and only offer to open when a gateway is detected; default model prompt now prefers Opus 4.5 for Anthropic auth.
- Control UI: show skill install progress + per-skill results, hide install once binaries present. (#445) — thanks @pkrmf
- Providers/Doctor: surface Discord privileged intent (Message Content) misconfiguration with actionable warnings.
- Providers/Doctor: warn when Telegram config expects unmentioned group messages but Bot API privacy mode is likely enabled; surface WhatsApp login/disconnect hints.
- Providers/Doctor: add last inbound/outbound activity timestamps in `providers status` and extend `--probe` with Discord channel permission + Telegram group membership audits.
- Docs: add provider troubleshooting index (`/providers/troubleshooting`) and link it from the main troubleshooting guide.
- Docs: clarify model allowlist errors and add safety notes for verbose/reasoning in groups.
- Docs: add Ansible installation guide. (#545) — thanks @pasogott
- Telegram: include the user id in DM pairing messages and label it clearly in `clawdbot pairing list --provider telegram`.
- Apps: refresh iOS/Android/macOS app icons for Clawdbot branding. (#521) — thanks @fishfisher
- Docs: expand parameter descriptions for agent/wake hooks. (#532) — thanks @mcinteerj
- Docs: add community showcase entries from Discord. (#476) — thanks @gupsammy
- TUI: refresh status bar after think/verbose/reasoning changes. (#519) — thanks @jdrhyne
- Status: show Verbose/Elevated only when enabled.
- Status: filter usage summary to the active model provider.
- Status: map model providers to usage sources so unrelated usage doesn’t appear.
- Status: fix Claude usage snapshots when `anthropic:default` is a setup-token lacking `user:profile` by preferring `anthropic:claude-cli`; optional claude.ai fallback via `CLAUDE_AI_SESSION_KEY` / `CLAUDE_WEB_COOKIE`.
- Commands: allow /elevated off in groups without a mention; keep /elevated on mention-gated.
- Commands: keep multi-directive messages from clearing directive handling.
- Commands: warn when /elevated runs in direct (unsandboxed) runtime.
- Commands: treat mention-bypassed group command messages as mentioned so elevated directives respond.
- Commands: return /status in directive-only multi-line messages.
- Models: fall back to configured models when the provider catalog is unavailable.
- Agent system prompt: add messaging guidance for reply routing and cross-session sends. (#526) — thanks @neist
- Agent: bypass Anthropic OAuth tool-name blocks by capitalizing built-ins and keeping pruning tool matching case-insensitive. (#553) — thanks @andrewting19
- Commands/Tools: disable /restart and gateway restart tool by default (enable with commands.restart=true).
- Gateway/CLI: add `clawdbot gateway discover` (Bonjour scan on `local.` + `clawdbot.internal.`) with `--timeout` and `--json`. — thanks @steipete
- Gateway/CLI: make `clawdbot gateway status` human-readable by default, add `--json`, and probe localhost + configured remote (warn on multiple gateways). — thanks @steipete
- Gateway/CLI: support remote loopback gateways via SSH tunnel in `clawdbot gateway status` (`--ssh` / `--ssh-auto`). — thanks @steipete
- Gateway/Discovery: include `gatewayPort`/`sshPort`/`cliPath` in wide-area Bonjour records, and add a tailnet DNS fallback for `gateway discover` when split DNS isn’t configured. — thanks @steipete
- CLI: add global `--no-color` (and respect `NO_COLOR=1`) to disable ANSI output. — thanks @steipete
- CLI: centralize lobster palette + apply it to onboarding/config prompts. — thanks @steipete
- Gateway/CLI: add `clawdbot gateway --dev/--reset` to auto-create a dev config/workspace with a robot identity (no BOOTSTRAP.md), and reset wipes config/creds/sessions/workspace (subcommand --dev no longer collides with global --dev profile). — thanks @steipete
- Configure: stop prompting to open the Control UI (still shown in onboarding). — thanks @steipete
- Configure: add wizard mode to remove a provider config block. — thanks @steipete
- Onboarding/TUI: prompt to start TUI (best option) when BOOTSTRAP.md exists and add `tui --message` to auto-send the first prompt. — thanks @steipete
- Telegram: suppress grammY getUpdates stack traces; log concise retry message instead. — thanks @steipete
- Gateway/CLI: allow dev profile (`clawdbot --dev`) to auto-create the dev config + workspace. — thanks @steipete
- Dev templates: ship C-3PO dev workspace defaults as docs templates and use them for dev bootstrap. — thanks @steipete
- Config: fix Minimax hosted onboarding to write `agents.defaults` and allow `msteams` as a heartbeat target. — thanks @steipete

## 2026.1.8

### Highlights
- Security: DMs locked down by default across providers; pairing-first + allowlist guidance.
- Sandbox: per-agent scope defaults + workspace access controls; tool/session isolation tuned.
- Agent loop: compaction, pruning, streaming, and error handling hardened.
- Providers: Telegram/WhatsApp/Discord/Slack reliability, threading, reactions, media, and retries improved.
- Control UI: logs tab, streaming stability, focus mode, and large-output rendering fixes.
- CLI/Gateway/Doctor: daemon/logs/status, auth migration, and diagnostics significantly expanded.

### Breaking
- **SECURITY (update ASAP):** inbound DMs are now **locked down by default** on Telegram/WhatsApp/Signal/iMessage/Discord/Slack.
  - Previously, if you didn’t configure an allowlist, your bot could be **open to anyone** (especially discoverable Telegram bots).
  - New default: DM pairing (`dmPolicy="pairing"` / `discord.dm.policy="pairing"` / `slack.dm.policy="pairing"`).
  - To keep old “open to everyone” behavior: set `dmPolicy="open"` and include `"*"` in the relevant `allowFrom` (Discord/Slack: `discord.dm.allowFrom` / `slack.dm.allowFrom`).
  - Approve requests via `clawdbot pairing list --provider <provider>` + `clawdbot pairing approve --provider <provider> <code>`.
- Sandbox: default `agent.sandbox.scope` to `"agent"` (one container/workspace per agent). Use `"session"` for per-session isolation; `"shared"` disables cross-session isolation.
- Timestamps in agent envelopes are now UTC (compact `YYYY-MM-DDTHH:mmZ`); removed `messages.timestampPrefix`. Add `agent.userTimezone` to tell the model the user’s local time (system prompt only).
- Model config schema changes (auth profiles + model lists); doctor auto-migrates and the gateway rewrites legacy configs on startup.
- Commands: gate all slash commands to authorized senders; add `/compact` to manually compact session context.
- Groups: `whatsapp.groups`, `telegram.groups`, and `imessage.groups` now act as allowlists when set. Add `"*"` to keep allow-all behavior.
- Auto-reply: removed `autoReply` from Discord/Slack/Telegram channel configs; use `requireMention` instead (Telegram topics now support `requireMention` overrides).
- CLI: remove `update`, `gateway-daemon`, `gateway {install|uninstall|start|stop|restart|daemon status|wake|send|agent}`, and `telegram` commands; move `login/logout` to `providers login/logout` (top-level aliases hidden); use `daemon` for service control, `send`/`agent`/`wake` for RPC, and `nodes canvas` for canvas ops.

### Fixes
- **CLI/Gateway/Doctor:** daemon runtime selection + improved logs/status/health/errors; auth/password handling for local CLI; richer close/timeout details; auto-migrate legacy config/sessions/state; integrity checks + repair prompts; `--yes`/`--non-interactive`; `--deep` gateway scans; better restart/service hints.
- **Agent loop + compaction:** compaction/pruning tuning, overflow handling, safer bootstrap context, and per-provider threading/confirmations; opt-in tool-result pruning + compact tracking.
- **Sandbox + tools:** per-agent sandbox overrides, workspaceAccess controls, session tool visibility, tool policy overrides, process isolation, and tool schema/timeout/reaction unification.
- **Providers (Telegram/WhatsApp/Discord/Slack/Signal/iMessage):** retry/backoff, threading, reactions, media groups/attachments, mention gating, typing behavior, and error/log stability; long polling + forum topic isolation for Telegram.
- **Gateway/CLI UX:** `clawdbot logs`, cron list colors/aliases, docs search, agents list/add/delete flows, status usage snapshots, runtime/auth source display, and `/status`/commands auth unification.
- **Control UI/Web:** logs tab, focus mode polish, config form resilience, streaming stability, tool output caps, windowed chat history, and reconnect/password URL auth.
- **macOS/Android/TUI/Build:** macOS gateway races, QR bundling, JSON5 config safety, Voice Wake hardening; Android EXIF rotation + APK naming/versioning; TUI key handling; tooling/bundling fixes.
- **Packaging/compat:** npm dist folder coverage, Node 25 qrcode-terminal import fixes, Bun/Playwright/WebSocket patches, and Docker Bun install.
- **Docs:** new FAQ/ClawdHub/config examples/showcase entries and clarified auth, sandbox, and systemd docs.

### Maintenance
- Skills additions (Himalaya email, CodexBar, 1Password).
- Dependency refreshes (pi-* stack, Slack SDK, discord-api-types, file-type, zod, Biome, Vite).
- Refactors: centralized group allowlist/mention policy; lint/import cleanup; switch tsx → bun for TS execution.

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
