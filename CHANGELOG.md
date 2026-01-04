# Changelog

**Why this looks different:** the project was renamed from **Clawdis → Clawdbot**. To make the transition clear, releases now use **date-based versions** (`YYYY.M.D`) and the changelog is **compressed** into milestone summaries. Full detail still lives in git history and the docs.

## Unreleased

### Highlights
- Models: add image-specific model config (`agent.imageModel` + fallbacks) and scan support.
- Agent tools: new `image` tool routed to the image model (when configured).

### Fixes
- Android: tapping the foreground service notification brings the app to the front. (#179) — thanks @Syhids
- Cron tool passes `id` to the gateway for update/remove/run/runs (keeps `jobId` input). (#180) — thanks @adamgall
- macOS: treat location permission as always-only to avoid iOS-only enums. (#165) — thanks @Nachx639
- macOS: make generated gateway protocol models `Sendable` for Swift 6 strict concurrency. (#195) — thanks @andranik-sahakyan
- Onboarding: when running from source, auto-build missing Control UI assets (`pnpm ui:build`).
- Discord/Slack: route reaction + system notifications to the correct session (no main-session bleed).

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
