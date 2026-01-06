# 🦞 CLAWDBOT — Personal AI Assistant

<p align="center">
  <img src="https://raw.githubusercontent.com/clawdbot/clawdbot/main/docs/whatsapp-clawd.jpg" alt="CLAWDBOT" width="400">
</p>

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

<p align="center">
  <a href="https://github.com/clawdbot/clawdbot/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/clawdbot/clawdbot/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/clawdbot/clawdbot/releases"><img src="https://img.shields.io/github/v/release/clawdbot/clawdbot?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Clawdbot** is a *personal AI assistant* you run on your own devices.
It answers you on the surfaces you already use (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat), can speak and listen on macOS/iOS/Android, and can render a live Canvas you control. The Gateway is just the control plane — the product is the assistant.

If you want a personal, single-user assistant that feels local, fast, and always-on, this is it.

[Website](https://clawdbot.com) · [Docs](https://github.com/clawdbot/clawdbot/blob/main/docs/index.md) · Showcase: [https://github.com/clawdbot/clawdbot/blob/main/docs/showcase.md](https://github.com/clawdbot/clawdbot/blob/main/docs/showcase.md) · FAQ: [https://github.com/clawdbot/clawdbot/blob/main/docs/faq.md](https://github.com/clawdbot/clawdbot/blob/main/docs/faq.md) · Wizard: [https://github.com/clawdbot/clawdbot/blob/main/docs/wizard.md](https://github.com/clawdbot/clawdbot/blob/main/docs/wizard.md) · Nix: [https://github.com/clawdbot/nix-clawdbot](https://github.com/clawdbot/nix-clawdbot) · Docker: [https://github.com/clawdbot/clawdbot/blob/main/docs/docker.md](https://github.com/clawdbot/clawdbot/blob/main/docs/docker.md) · Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

Preferred setup: run the onboarding wizard (`clawdbot onboard`). It walks through gateway, workspace, providers, and skills. The CLI wizard is the recommended path and works on **macOS, Windows, and Linux**.
Works with npm, pnpm, or bun.

**Subscriptions (OAuth):**
- **Anthropic** (Claude Pro/Max)
- **OpenAI** (ChatGPT/Codex)

Model note: while any model is supported, I strongly recommend **Anthropic Pro/Max (100/200) + Opus 4.5** for long‑context strength and better prompt‑injection resistance. See [Onboarding](https://github.com/clawdbot/clawdbot/blob/main/docs/onboarding.md).

## Recommended setup (from source)

Do **not** download prebuilt binaries. Build from source.

```bash
# Clone this repo
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot

bun install
bun run build
bun run ui:build
bun run clawdbot onboard
```

## Quick start (from source)

Runtime: **Node ≥22**.

From source, **pnpm** is the default workflow. Bun is supported as an optional local workflow; see [`docs/bun.md`](docs/bun.md).

```bash
# Install deps (no Bun lockfile)
bun install --no-save

# Build TypeScript
bun run build

# Build Control UI
bun install --cwd ui --no-save
bun run --cwd ui build

# Recommended: run the onboarding wizard
bun run clawdbot onboard

# Link WhatsApp (stores creds in ~/.clawdbot/credentials)
bun run clawdbot login

# Start the gateway
bun run clawdbot gateway --port 18789 --verbose

# Dev loop (auto-reload on TS changes)
bun run gateway:watch

# Send a message
bun run clawdbot send --to +1234567890 --message "Hello from Clawdbot"

# Talk to the assistant (optionally deliver back to WhatsApp/Telegram/Slack/Discord)
bun run clawdbot agent --message "Ship checklist" --thinking high
```

Upgrading? `clawdbot doctor`.

If you run from source, prefer `bun run clawdbot …` or `pnpm clawdbot …` (not global `clawdbot`).

## Highlights

- **[Local-first Gateway](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway.md)** — single control plane for sessions, providers, tools, and events.
- **[Multi-surface inbox](https://github.com/clawdbot/clawdbot/blob/main/docs/surface.md)** — WhatsApp, Telegram, Slack, Discord, Signal, iMessage, WebChat, macOS, iOS/Android.
- **[Voice Wake](https://github.com/clawdbot/clawdbot/blob/main/docs/voicewake.md) + [Talk Mode](https://github.com/clawdbot/clawdbot/blob/main/docs/talk.md)** — always-on speech for macOS/iOS/Android with ElevenLabs.
- **[Live Canvas](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md)** — agent-driven visual workspace with [A2UI](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md#canvas-a2ui).
- **[First-class tools](https://github.com/clawdbot/clawdbot/blob/main/docs/tools.md)** — browser, canvas, nodes, cron, sessions, and Discord/Slack actions.
- **[Companion apps](https://github.com/clawdbot/clawdbot/blob/main/docs/macos.md)** — macOS menu bar app + iOS/Android [nodes](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md).
- **[Onboarding](https://github.com/clawdbot/clawdbot/blob/main/docs/wizard.md) + [skills](https://github.com/clawdbot/clawdbot/blob/main/docs/skills.md)** — wizard-driven setup with bundled/managed/workspace skills.

## Everything we built so far

### Core platform
- [Gateway WS control plane](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway.md) with sessions, presence, config, cron, webhooks, [Control UI](https://github.com/clawdbot/clawdbot/blob/main/docs/web.md), and [Canvas host](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md#canvas-a2ui).
- [CLI surface](https://github.com/clawdbot/clawdbot/blob/main/docs/agent-send.md): gateway, agent, send, [wizard](https://github.com/clawdbot/clawdbot/blob/main/docs/wizard.md), and [doctor](https://github.com/clawdbot/clawdbot/blob/main/docs/doctor.md).
- [Pi agent runtime](https://github.com/clawdbot/clawdbot/blob/main/docs/agent.md) in RPC mode with tool streaming and block streaming.
- [Session model](https://github.com/clawdbot/clawdbot/blob/main/docs/session.md): `main` for direct chats, group isolation, activation modes, queue modes, reply-back. Group rules: [Groups](https://github.com/clawdbot/clawdbot/blob/main/docs/groups.md).
- [Media pipeline](https://github.com/clawdbot/clawdbot/blob/main/docs/images.md): images/audio/video, transcription hooks, size caps, temp file lifecycle. Audio details: [Audio](https://github.com/clawdbot/clawdbot/blob/main/docs/audio.md).

### Surfaces + providers
- [Providers](https://github.com/clawdbot/clawdbot/blob/main/docs/surface.md): [WhatsApp](https://github.com/clawdbot/clawdbot/blob/main/docs/whatsapp.md) (Baileys), [Telegram](https://github.com/clawdbot/clawdbot/blob/main/docs/telegram.md) (grammY), [Slack](https://github.com/clawdbot/clawdbot/blob/main/docs/slack.md) (Bolt), [Discord](https://github.com/clawdbot/clawdbot/blob/main/docs/discord.md) (discord.js), [Signal](https://github.com/clawdbot/clawdbot/blob/main/docs/signal.md) (signal-cli), [iMessage](https://github.com/clawdbot/clawdbot/blob/main/docs/imessage.md) (imsg), [WebChat](https://github.com/clawdbot/clawdbot/blob/main/docs/webchat.md).
- [Group routing](https://github.com/clawdbot/clawdbot/blob/main/docs/group-messages.md): mention gating, reply tags, per-surface chunking and routing. Surface rules: [Surface routing](https://github.com/clawdbot/clawdbot/blob/main/docs/surface.md).

### Apps + nodes
- [macOS app](https://github.com/clawdbot/clawdbot/blob/main/docs/macos.md): menu bar control plane, [Voice Wake](https://github.com/clawdbot/clawdbot/blob/main/docs/voicewake.md)/PTT, [Talk Mode](https://github.com/clawdbot/clawdbot/blob/main/docs/talk.md) overlay, [WebChat](https://github.com/clawdbot/clawdbot/blob/main/docs/webchat.md), debug tools, [remote gateway](https://github.com/clawdbot/clawdbot/blob/main/docs/remote.md) control.
- [iOS node](https://github.com/clawdbot/clawdbot/blob/main/docs/ios.md): [Canvas](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md), [Voice Wake](https://github.com/clawdbot/clawdbot/blob/main/docs/voicewake.md), [Talk Mode](https://github.com/clawdbot/clawdbot/blob/main/docs/talk.md), camera, screen recording, Bonjour pairing.
- [Android node](https://github.com/clawdbot/clawdbot/blob/main/docs/android.md): [Canvas](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md), [Talk Mode](https://github.com/clawdbot/clawdbot/blob/main/docs/talk.md), camera, screen recording, optional SMS.
- [macOS node mode](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md): system.run/notify + canvas/camera exposure.

### Tools + automation
- [Browser control](https://github.com/clawdbot/clawdbot/blob/main/docs/browser.md): dedicated clawd Chrome/Chromium, snapshots, actions, uploads, profiles.
- [Canvas](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md): [A2UI](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md#canvas-a2ui) push/reset, eval, snapshot.
- [Nodes](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md): camera snap/clip, screen record, [location.get](https://github.com/clawdbot/clawdbot/blob/main/docs/location-command.md), notifications.
- [Cron + wakeups](https://github.com/clawdbot/clawdbot/blob/main/docs/cron.md); [webhooks](https://github.com/clawdbot/clawdbot/blob/main/docs/webhook.md); [Gmail Pub/Sub](https://github.com/clawdbot/clawdbot/blob/main/docs/gmail-pubsub.md).
- [Skills platform](https://github.com/clawdbot/clawdbot/blob/main/docs/skills.md): bundled, managed, and workspace skills with install gating + UI.

### Ops + packaging
- [Control UI](https://github.com/clawdbot/clawdbot/blob/main/docs/web.md) + [WebChat](https://github.com/clawdbot/clawdbot/blob/main/docs/webchat.md) served directly from the Gateway.
- [Tailscale Serve/Funnel](https://github.com/clawdbot/clawdbot/blob/main/docs/tailscale.md) or [SSH tunnels](https://github.com/clawdbot/clawdbot/blob/main/docs/remote.md) with token/password auth.
- [Nix mode](https://github.com/clawdbot/clawdbot/blob/main/docs/nix.md) for declarative config; [Docker](https://github.com/clawdbot/clawdbot/blob/main/docs/docker.md)-based installs.
- [Doctor](https://github.com/clawdbot/clawdbot/blob/main/docs/doctor.md) migrations, [logging](https://github.com/clawdbot/clawdbot/blob/main/docs/logging.md).

## How it works (short)

```
WhatsApp / Telegram / Slack / Discord / Signal / iMessage / WebChat
               │
               ▼
┌───────────────────────────────┐
│            Gateway            │  ws://127.0.0.1:18789
│       (control plane)         │  bridge: tcp://0.0.0.0:18790
└──────────────┬────────────────┘
               │
               ├─ Pi agent (RPC)
               ├─ CLI (clawdbot …)
               ├─ WebChat UI
               ├─ macOS app
               └─ iOS/Android nodes
```

## Key subsystems

- **[Gateway WebSocket network](https://github.com/clawdbot/clawdbot/blob/main/docs/architecture.md)** — single WS control plane for clients, tools, and events (plus ops: [Gateway runbook](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway.md)).
- **[Tailscale exposure](https://github.com/clawdbot/clawdbot/blob/main/docs/tailscale.md)** — Serve/Funnel for the Gateway dashboard + WS (remote access: [Remote](https://github.com/clawdbot/clawdbot/blob/main/docs/remote.md)).
- **[Browser control](https://github.com/clawdbot/clawdbot/blob/main/docs/browser.md)** — clawd‑managed Chrome/Chromium with CDP control.
- **[Canvas + A2UI](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md)** — agent‑driven visual workspace (A2UI host: [Canvas/A2UI](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/canvas.md#canvas-a2ui)).
- **[Voice Wake](https://github.com/clawdbot/clawdbot/blob/main/docs/voicewake.md) + [Talk Mode](https://github.com/clawdbot/clawdbot/blob/main/docs/talk.md)** — always‑on speech and continuous conversation.
- **[Nodes](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md)** — Canvas, camera snap/clip, screen record, `location.get`, notifications, plus macOS‑only `system.run`/`system.notify`.

## Tailscale access (Gateway dashboard)

Clawdbot can auto-configure Tailscale **Serve** (tailnet-only) or **Funnel** (public) while the Gateway stays bound to loopback. Configure `gateway.tailscale.mode`:

- `off`: no Tailscale automation (default).
- `serve`: tailnet-only HTTPS via `tailscale serve` (uses Tailscale identity headers by default).
- `funnel`: public HTTPS via `tailscale funnel` (requires shared password auth).

Notes:
- `gateway.bind` must stay `loopback` when Serve/Funnel is enabled (Clawdbot enforces this).
- Serve can be forced to require a password by setting `gateway.auth.mode: "password"` or `gateway.auth.allowTailscale: false`.
- Funnel refuses to start unless `gateway.auth.mode: "password"` is set.
- Optional: `gateway.tailscale.resetOnExit` to undo Serve/Funnel on shutdown.

Details: [Tailscale guide](https://github.com/clawdbot/clawdbot/blob/main/docs/tailscale.md) · [Web surfaces](https://github.com/clawdbot/clawdbot/blob/main/docs/web.md)

## Remote Gateway (Linux is great)

It’s perfectly fine to run the Gateway on a small Linux instance. Clients (macOS app, CLI, WebChat) can connect over **Tailscale Serve/Funnel** or **SSH tunnels**, and you can still pair device nodes (macOS/iOS/Android) to execute device‑local actions when needed.

- **Gateway host** runs the bash tool and provider connections by default.
- **Device nodes** run device‑local actions (`system.run`, camera, screen recording, notifications) via `node.invoke`.
In short: bash runs where the Gateway lives; device actions run where the device lives.

Details: [Remote access](https://github.com/clawdbot/clawdbot/blob/main/docs/remote.md) · [Nodes](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md) · [Security](https://github.com/clawdbot/clawdbot/blob/main/docs/security.md)

## macOS permissions via the Gateway protocol

The macOS app can run in **node mode** and advertises its capabilities + permission map over the Gateway WebSocket (`node.list` / `node.describe`). Clients can then execute local actions via `node.invoke`:

- `system.run` runs a local command and returns stdout/stderr/exit code; set `needsScreenRecording: true` to require screen-recording permission (otherwise you’ll get `PERMISSION_MISSING`).
- `system.notify` posts a user notification and fails if notifications are denied.
- `canvas.*`, `camera.*`, `screen.record`, and `location.get` are also routed via `node.invoke` and follow TCC permission status.

Elevated bash (host permissions) is separate from macOS TCC:

- Use `/elevated on|off` to toggle per‑session elevated access when enabled + allowlisted.
- Gateway persists the per‑session toggle via `sessions.patch` (WS method) alongside `thinkingLevel`, `verboseLevel`, `model`, `sendPolicy`, and `groupActivation`.

Details: [Nodes](https://github.com/clawdbot/clawdbot/blob/main/docs/nodes.md) · [macOS app](https://github.com/clawdbot/clawdbot/blob/main/docs/macos.md) · [Gateway protocol](https://github.com/clawdbot/clawdbot/blob/main/docs/architecture.md)

## Agent to Agent (sessions_* tools)

- Use these to coordinate work across sessions without jumping between chat surfaces.
- `sessions_list` — discover active sessions (agents) and their metadata.
- `sessions_history` — fetch transcript logs for a session.
- `sessions_send` — message another session; optional reply‑back ping‑pong + announce step (`REPLY_SKIP`, `ANNOUNCE_SKIP`).

Details: [Session tools](https://github.com/clawdbot/clawdbot/blob/main/docs/session-tool.md)

## Skills registry (ClawdHub)

ClawdHub is a minimal skill registry. With ClawdHub enabled, the agent can search for skills automatically and pull in new ones as needed.

https://ClawdHub.com

## Chat commands

Send these in WhatsApp/Telegram/Slack/WebChat (group commands are owner-only):

- `/status` — health + session info (group shows activation mode)
- `/new` or `/reset` — reset the session
- `/compact` — compact session context (summary)
- `/think <level>` — off|minimal|low|medium|high
- `/verbose on|off`
- `/restart` — restart the gateway (owner-only in groups)
- `/activation mention|always` — group activation toggle (groups only)

## macOS app (optional)

The Gateway alone delivers a great experience. All apps are optional and add extra features.

If you plan to build/run companion apps, initialize submodules first:

```bash
git submodule update --init --recursive
./scripts/restart-mac.sh
```

### macOS (Clawdbot.app) (optional)

- Menu bar control for the Gateway and health.
- Voice Wake + push-to-talk overlay.
- WebChat + debug tools.
- Remote gateway control over SSH.

Note: signed builds required for macOS permissions to stick across rebuilds (see `docs/mac/permissions.md`).

### iOS node (optional)

- Pairs as a node via the Bridge.
- Voice trigger forwarding + Canvas surface.
- Controlled via `clawdbot nodes …`.

Runbook: [iOS connect](https://github.com/clawdbot/clawdbot/blob/main/docs/ios.md).

### Android node (optional)

- Pairs via the same Bridge + pairing flow as iOS.
- Exposes Canvas, Camera, and Screen capture commands.
- Runbook: [Android connect](https://github.com/clawdbot/clawdbot/blob/main/docs/android.md).

## Agent workspace + skills

- Workspace root: `~/clawd` (configurable via `agent.workspace`).
- Injected prompt files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`.
- Skills: `~/clawd/skills/<skill>/SKILL.md`.

## Configuration

Minimal `~/.clawdbot/clawdbot.json` (model + defaults):

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-5"
  }
}
```

[Full configuration reference (all keys + examples).](https://github.com/clawdbot/clawdbot/blob/main/docs/configuration.md)

## Security model (important)

- **Default:** tools run on the host for the **main** session, so the agent has full access when it’s just you.
- **Group/channel safety:** set `agent.sandbox.mode: "non-main"` to run **non‑main sessions** (groups/channels) inside per‑session Docker sandboxes; bash then runs in Docker for those sessions.
- **Sandbox defaults:** allowlist `bash`, `process`, `read`, `write`, `edit`; denylist `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`.

Details: [Security guide](https://github.com/clawdbot/clawdbot/blob/main/docs/security.md) · [Docker + sandboxing](https://github.com/clawdbot/clawdbot/blob/main/docs/docker.md) · [Sandbox config](https://github.com/clawdbot/clawdbot/blob/main/docs/configuration.md)

### [WhatsApp](https://github.com/clawdbot/clawdbot/blob/main/docs/whatsapp.md)

- Link the device: `pnpm clawdbot login` (stores creds in `~/.clawdbot/credentials`).
- Allowlist who can talk to the assistant via `whatsapp.allowFrom`.
- If `whatsapp.groups` is set, it becomes a group allowlist; include `"*"` to allow all.

### [Telegram](https://github.com/clawdbot/clawdbot/blob/main/docs/telegram.md)

- Set `TELEGRAM_BOT_TOKEN` or `telegram.botToken` (env wins).
- Optional: set `telegram.groups` (with `telegram.groups."*".requireMention`); when set, it is a group allowlist (include `"*"` to allow all). Also `telegram.allowFrom` or `telegram.webhookUrl` as needed.

```json5
{
  telegram: {
    botToken: "123456:ABCDEF"
  }
}
```

### [Slack](https://github.com/clawdbot/clawdbot/blob/main/docs/slack.md)

- Set `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (or `slack.botToken` + `slack.appToken`).

### [Discord](https://github.com/clawdbot/clawdbot/blob/main/docs/discord.md)

- Set `DISCORD_BOT_TOKEN` or `discord.token` (env wins).
- Optional: set `discord.slashCommand`, `discord.dm.allowFrom`, `discord.guilds`, or `discord.mediaMaxMb` as needed.

```json5
{
  discord: {
    token: "1234abcd"
  }
}
```

### [Signal](https://github.com/clawdbot/clawdbot/blob/main/docs/signal.md)

- Requires `signal-cli` and a `signal` config section.

### [iMessage](https://github.com/clawdbot/clawdbot/blob/main/docs/imessage.md)

- macOS only; Messages must be signed in.
- If `imessage.groups` is set, it becomes a group allowlist; include `"*"` to allow all.

### [WebChat](https://github.com/clawdbot/clawdbot/blob/main/docs/webchat.md)

- Uses the Gateway WebSocket; no separate WebChat port/config.

Browser control (optional):

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    color: "#FF4500"
  }
}
```

## Docs

Use these when you’re past the onboarding flow and want the deeper reference.
- [Start with the docs index for navigation and “what’s where.”](https://github.com/clawdbot/clawdbot/blob/main/docs/index.md)
- [Read the architecture overview for the gateway + protocol model.](https://github.com/clawdbot/clawdbot/blob/main/docs/architecture.md)
- [Use the full configuration reference when you need every key and example.](https://github.com/clawdbot/clawdbot/blob/main/docs/configuration.md)
- [Run the Gateway by the book with the operational runbook.](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway.md)
- [Learn how the Control UI/Web surfaces work and how to expose them safely.](https://github.com/clawdbot/clawdbot/blob/main/docs/web.md)
- [Understand remote access over SSH tunnels or tailnets.](https://github.com/clawdbot/clawdbot/blob/main/docs/remote.md)
- [Follow the onboarding wizard flow for a guided setup.](https://github.com/clawdbot/clawdbot/blob/main/docs/wizard.md)
- [Wire external triggers via the webhook surface.](https://github.com/clawdbot/clawdbot/blob/main/docs/webhook.md)
- [Set up Gmail Pub/Sub triggers.](https://github.com/clawdbot/clawdbot/blob/main/docs/gmail-pubsub.md)
- [Learn the macOS menu bar companion details.](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/menu-bar.md)
- [Platform guides: Windows](https://github.com/clawdbot/clawdbot/blob/main/docs/windows.md), [Linux](https://github.com/clawdbot/clawdbot/blob/main/docs/linux.md), [macOS](https://github.com/clawdbot/clawdbot/blob/main/docs/macos.md), [iOS](https://github.com/clawdbot/clawdbot/blob/main/docs/ios.md), [Android](https://github.com/clawdbot/clawdbot/blob/main/docs/android.md)
- [Debug common failures with the troubleshooting guide.](https://github.com/clawdbot/clawdbot/blob/main/docs/troubleshooting.md)
- [Review security guidance before exposing anything.](https://github.com/clawdbot/clawdbot/blob/main/docs/security.md)

## Advanced docs (discovery + control)

- [Discovery + transports](https://github.com/clawdbot/clawdbot/blob/main/docs/discovery.md)
- [Bonjour/mDNS](https://github.com/clawdbot/clawdbot/blob/main/docs/bonjour.md)
- [Gateway pairing](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway/pairing.md)
- [Remote gateway README](https://github.com/clawdbot/clawdbot/blob/main/docs/remote-gateway-readme.md)
- [Control UI](https://github.com/clawdbot/clawdbot/blob/main/docs/control-ui.md)
- [Dashboard](https://github.com/clawdbot/clawdbot/blob/main/docs/dashboard.md)

## Operations & troubleshooting

- [Health checks](https://github.com/clawdbot/clawdbot/blob/main/docs/health.md)
- [Gateway lock](https://github.com/clawdbot/clawdbot/blob/main/docs/gateway-lock.md)
- [Background process](https://github.com/clawdbot/clawdbot/blob/main/docs/background-process.md)
- [Browser troubleshooting (Linux)](https://github.com/clawdbot/clawdbot/blob/main/docs/browser-linux-troubleshooting.md)
- [Logging](https://github.com/clawdbot/clawdbot/blob/main/docs/logging.md)

## Deep dives

- [Agent loop](https://github.com/clawdbot/clawdbot/blob/main/docs/agent-loop.md)
- [Presence](https://github.com/clawdbot/clawdbot/blob/main/docs/presence.md)
- [TypeBox schemas](https://github.com/clawdbot/clawdbot/blob/main/docs/typebox.md)
- [RPC adapters](https://github.com/clawdbot/clawdbot/blob/main/docs/rpc.md)
- [Queue](https://github.com/clawdbot/clawdbot/blob/main/docs/queue.md)

## Workspace & skills

- [Skills config](https://github.com/clawdbot/clawdbot/blob/main/docs/skills-config.md)
- [Default AGENTS](https://github.com/clawdbot/clawdbot/blob/main/docs/AGENTS.default.md)
- [Templates: AGENTS](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/AGENTS.md)
- [Templates: BOOTSTRAP](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/BOOTSTRAP.md)
- [Templates: IDENTITY](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/IDENTITY.md)
- [Templates: SOUL](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/SOUL.md)
- [Templates: TOOLS](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/TOOLS.md)
- [Templates: USER](https://github.com/clawdbot/clawdbot/blob/main/docs/templates/USER.md)

## Platform internals

- [macOS dev setup](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/dev-setup.md)
- [macOS menu bar](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/menu-bar.md)
- [macOS voice wake](https://github.com/clawdbot/clawdbot/blob/main/docs/mac/voicewake.md)
- [iOS node](https://github.com/clawdbot/clawdbot/blob/main/docs/ios.md)
- [Android node](https://github.com/clawdbot/clawdbot/blob/main/docs/android.md)
- [Windows app](https://github.com/clawdbot/clawdbot/blob/main/docs/windows.md)
- [Linux app](https://github.com/clawdbot/clawdbot/blob/main/docs/linux.md)

## Email hooks (Gmail)

[Gmail Pub/Sub wiring (gcloud + gogcli), hook tokens, and auto-watch behavior are documented here.](https://github.com/clawdbot/clawdbot/blob/main/docs/gmail-pubsub.md)

Gateway auto-starts the watcher when `hooks.enabled=true` and `hooks.gmail.account` is set; `clawdbot hooks gmail run` is the manual daemon wrapper if you don’t want auto-start.

```bash
clawdbot hooks gmail setup --account you@gmail.com
clawdbot hooks gmail run
```

## Clawd

Clawdbot was built for **Clawd**, a space lobster AI assistant. 🦞  
by Peter Steinberger and the community.

- https://clawd.me
- https://soul.md
- https://steipete.me

## Community

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, maintainers, and how to submit PRs.  
AI/vibe-coded PRs welcome! 🤖

Thanks to all clawtributors:

<p align="left">
  <a href="https://github.com/steipete"><img src="https://avatars.githubusercontent.com/u/58493?v=4&s=48" width="48" height="48" alt="steipete" title="steipete"/></a> <a href="https://github.com/thewilloftheshadow"><img src="https://avatars.githubusercontent.com/u/35580099?v=4&s=48" width="48" height="48" alt="thewilloftheshadow" title="thewilloftheshadow"/></a> <a href="https://github.com/mcinteerj"><img src="https://avatars.githubusercontent.com/u/3613653?v=4&s=48" width="48" height="48" alt="mcinteerj" title="mcinteerj"/></a> <a href="https://github.com/joshp123"><img src="https://avatars.githubusercontent.com/u/1497361?v=4&s=48" width="48" height="48" alt="joshp123" title="joshp123"/></a> <a href="https://github.com/joaohlisboa"><img src="https://avatars.githubusercontent.com/u/8200873?v=4&s=48" width="48" height="48" alt="joaohlisboa" title="joaohlisboa"/></a> <a href="https://github.com/petter-b"><img src="https://avatars.githubusercontent.com/u/62076402?v=4&s=48" width="48" height="48" alt="petter-b" title="petter-b"/></a> <a href="https://github.com/mukhtharcm"><img src="https://avatars.githubusercontent.com/u/56378562?v=4&s=48" width="48" height="48" alt="mukhtharcm" title="mukhtharcm"/></a> <a href="https://github.com/dan-dr"><img src="https://avatars.githubusercontent.com/u/6669808?v=4&s=48" width="48" height="48" alt="dan-dr" title="dan-dr"/></a> <a href="https://github.com/Nachx639"><img src="https://avatars.githubusercontent.com/u/71144023?v=4&s=48" width="48" height="48" alt="Nachx639" title="Nachx639"/></a> <a href="https://github.com/jeffersonwarrior"><img src="https://avatars.githubusercontent.com/u/89030989?v=4&s=48" width="48" height="48" alt="jeffersonwarrior" title="jeffersonwarrior"/></a>
  <a href="https://github.com/mbelinky"><img src="https://avatars.githubusercontent.com/u/132747814?v=4&s=48" width="48" height="48" alt="mbelinky" title="mbelinky"/></a> <a href="https://github.com/julianengel"><img src="https://avatars.githubusercontent.com/u/10634231?v=4&s=48" width="48" height="48" alt="julianengel" title="julianengel"/></a> <a href="https://github.com/CashWilliams"><img src="https://avatars.githubusercontent.com/u/613573?v=4&s=48" width="48" height="48" alt="CashWilliams" title="CashWilliams"/></a> <a href="https://github.com/omniwired"><img src="https://avatars.githubusercontent.com/u/322761?v=4&s=48" width="48" height="48" alt="omniwired" title="omniwired"/></a> <a href="https://github.com/jverdi"><img src="https://avatars.githubusercontent.com/u/345050?v=4&s=48" width="48" height="48" alt="jverdi" title="jverdi"/></a> <a href="https://github.com/Syhids"><img src="https://avatars.githubusercontent.com/u/671202?v=4&s=48" width="48" height="48" alt="Syhids" title="Syhids"/></a> <a href="https://github.com/meaningfool"><img src="https://avatars.githubusercontent.com/u/2862331?v=4&s=48" width="48" height="48" alt="meaningfool" title="meaningfool"/></a> <a href="https://github.com/rafaelreis-r"><img src="https://avatars.githubusercontent.com/u/57492577?v=4&s=48" width="48" height="48" alt="rafaelreis-r" title="rafaelreis-r"/></a> <a href="https://github.com/wstock"><img src="https://avatars.githubusercontent.com/u/1394687?v=4&s=48" width="48" height="48" alt="wstock" title="wstock"/></a> <a href="https://github.com/vsabavat"><img src="https://avatars.githubusercontent.com/u/50385532?v=4&s=48" width="48" height="48" alt="vsabavat" title="vsabavat"/></a>
  <a href="https://github.com/scald"><img src="https://avatars.githubusercontent.com/u/1215913?v=4&s=48" width="48" height="48" alt="scald" title="scald"/></a> <a href="https://github.com/sreekaransrinath"><img src="https://avatars.githubusercontent.com/u/50989977?v=4&s=48" width="48" height="48" alt="sreekaransrinath" title="sreekaransrinath"/></a> <a href="https://github.com/ratulsarna"><img src="https://avatars.githubusercontent.com/u/105903728?v=4&s=48" width="48" height="48" alt="ratulsarna" title="ratulsarna"/></a> <a href="https://github.com/osolmaz"><img src="https://avatars.githubusercontent.com/u/2453968?v=4&s=48" width="48" height="48" alt="osolmaz" title="osolmaz"/></a> <a href="https://github.com/conhecendocontato"><img src="https://avatars.githubusercontent.com/u/82890727?v=4&s=48" width="48" height="48" alt="conhecendocontato" title="conhecendocontato"/></a> <a href="https://github.com/hrdwdmrbl"><img src="https://avatars.githubusercontent.com/u/554881?v=4&s=48" width="48" height="48" alt="hrdwdmrbl" title="hrdwdmrbl"/></a> <a href="https://github.com/jayhickey"><img src="https://avatars.githubusercontent.com/u/1676460?v=4&s=48" width="48" height="48" alt="jayhickey" title="jayhickey"/></a> <a href="https://github.com/jamesgroat"><img src="https://avatars.githubusercontent.com/u/2634024?v=4&s=48" width="48" height="48" alt="jamesgroat" title="jamesgroat"/></a> <a href="https://github.com/gtsifrikas"><img src="https://avatars.githubusercontent.com/u/8904378?v=4&s=48" width="48" height="48" alt="gtsifrikas" title="gtsifrikas"/></a> <a href="https://github.com/djangonavarro220"><img src="https://avatars.githubusercontent.com/u/251162586?v=4&s=48" width="48" height="48" alt="djangonavarro220" title="djangonavarro220"/></a>
  <a href="https://github.com/azade-c"><img src="https://avatars.githubusercontent.com/u/252790079?v=4&s=48" width="48" height="48" alt="azade-c" title="azade-c"/></a> <a href="https://github.com/andranik-sahakyan"><img src="https://avatars.githubusercontent.com/u/8908029?v=4&s=48" width="48" height="48" alt="andranik-sahakyan" title="andranik-sahakyan"/></a>
  <a href="https://github.com/adamgall"><img src="https://avatars.githubusercontent.com/u/706929?v=4&s=48" width="48" height="48" alt="adamgall" title="adamgall"/></a> <a href="https://github.com/jalehman"><img src="https://avatars.githubusercontent.com/u/550978?v=4&s=48" width="48" height="48" alt="jalehman" title="jalehman"/></a> <a href="https://github.com/jarvis-medmatic"><img src="https://avatars.githubusercontent.com/u/252428873?v=4&s=48" width="48" height="48" alt="jarvis-medmatic" title="jarvis-medmatic"/></a> <a href="https://github.com/mneves75"><img src="https://avatars.githubusercontent.com/u/2423436?v=4&s=48" width="48" height="48" alt="mneves75" title="mneves75"/></a> <a href="https://github.com/regenrek"><img src="https://avatars.githubusercontent.com/u/5182020?v=4&s=48" width="48" height="48" alt="regenrek" title="regenrek"/></a> <a href="https://github.com/tobiasbischoff"><img src="https://avatars.githubusercontent.com/u/711564?v=4&s=48" width="48" height="48" alt="tobiasbischoff" title="tobiasbischoff"/></a> <a href="https://github.com/MSch"><img src="https://avatars.githubusercontent.com/u/7475?v=4&s=48" width="48" height="48" alt="MSch" title="MSch"/></a> <a href="https://github.com/obviyus"><img src="https://avatars.githubusercontent.com/u/22031114?v=4&s=48" width="48" height="48" alt="obviyus" title="obviyus"/></a> <a href="https://github.com/dbhurley"><img src="https://avatars.githubusercontent.com/u/5251425?v=4&s=48" width="48" height="48" alt="dbhurley" title="dbhurley"/></a>
  <a href="https://github.com/Asleep123"><img src="https://avatars.githubusercontent.com/u/122379135?v=4&s=48" width="48" height="48" alt="Asleep123" title="Asleep123"/></a> <a href="https://github.com/Iamadig"><img src="https://avatars.githubusercontent.com/u/102129234?v=4&s=48" width="48" height="48" alt="Iamadig" title="Iamadig"/></a> <a href="https://github.com/imfing"><img src="https://avatars.githubusercontent.com/u/5097752?v=4&s=48" width="48" height="48" alt="imfing" title="imfing"/></a> <a href="https://github.com/kitze"><img src="https://avatars.githubusercontent.com/u/1160594?v=4&s=48" width="48" height="48" alt="kitze" title="kitze"/></a> <a href="https://github.com/nachoiacovino"><img src="https://avatars.githubusercontent.com/u/50103937?v=4&s=48" width="48" height="48" alt="nachoiacovino" title="nachoiacovino"/></a> <a href="https://github.com/VACInc"><img src="https://avatars.githubusercontent.com/u/3279061?v=4&s=48" width="48" height="48" alt="VACInc" title="VACInc"/></a> <a href="https://github.com/cash-echo-bot"><img src="https://avatars.githubusercontent.com/u/252747386?v=4&s=48" width="48" height="48" alt="cash-echo-bot" title="cash-echo-bot"/></a> <a href="https://github.com/claude"><img src="https://avatars.githubusercontent.com/u/81847?v=4&s=48" width="48" height="48" alt="claude" title="claude"/></a> <a href="https://github.com/kiranjd"><img src="https://avatars.githubusercontent.com/u/25822851?v=4&s=48" width="48" height="48" alt="kiranjd" title="kiranjd"/></a> <a href="https://github.com/pcty-nextgen-service-account"><img src="https://avatars.githubusercontent.com/u/112553441?v=4&s=48" width="48" height="48" alt="pcty-nextgen-service-account" title="pcty-nextgen-service-account"/></a>
</p>
