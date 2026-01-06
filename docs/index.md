---
summary: "Top-level overview of Clawdbot, features, and purpose"
read_when:
  - Introducing Clawdbot to newcomers
---
# CLAWDBOT 🦞

> *"EXFOLIATE! EXFOLIATE!"* — A space lobster, probably

<p align="center">
  <img src="whatsapp-clawd.jpg" alt="CLAWDBOT" width="420" />
</p>

<p align="center">
  <strong>Any OS + WhatsApp/Telegram/Discord/iMessage gateway for AI agents (Pi).</strong><br />
  Send a message, get an agent response — from your pocket.
</p>

<p align="center">
  <a href="https://github.com/clawdbot/clawdbot">GitHub</a> ·
  <a href="https://github.com/clawdbot/clawdbot/releases">Releases</a> ·
  <a href="https://github.com/clawdbot/clawdbot/blob/main/docs/index.md">Docs</a> ·
  <a href="./clawd.md">Clawd setup</a>
</p>

CLAWDBOT bridges WhatsApp (via WhatsApp Web / Baileys), Telegram (Bot API / grammY), Discord (Bot API / discord.js), and iMessage (imsg CLI) to coding agents like [Pi](https://github.com/badlogic/pi-mono).
It’s built for [Clawd](https://clawd.me), a space lobster who needed a TARDIS.

## How it works

```
WhatsApp / Telegram / Discord
        │
        ▼
  ┌──────────────────────────┐
  │          Gateway          │  ws://127.0.0.1:18789 (loopback-only)
  │     (single source)       │  tcp://0.0.0.0:18790 (Bridge)
  │                          │  http://<gateway-host>:18793/__clawdbot__/canvas/ (Canvas host)
  └───────────┬───────────────┘
              │
              ├─ Pi agent (RPC)
              ├─ CLI (clawdbot …)
              ├─ Chat UI (SwiftUI)
              ├─ macOS app (Clawdbot.app)
              ├─ iOS node via Bridge + pairing
              └─ Android node via Bridge + pairing
```

Most operations flow through the **Gateway** (`clawdbot gateway`), a single long-running process that owns provider connections and the WebSocket control plane.

## Network model

- **One Gateway per host**: it is the only process allowed to own the WhatsApp Web session.
- **Loopback-first**: Gateway WS defaults to `ws://127.0.0.1:18789`.
  - For Tailnet access, run `clawdbot gateway --bind tailnet --token ...` (token is required for non-loopback binds).
- **Bridge for nodes**: optional LAN/tailnet-facing bridge on `tcp://0.0.0.0:18790` for paired nodes (Bonjour-discoverable).
- **Canvas host**: HTTP file server on `canvasHost.port` (default `18793`), serving `/__clawdbot__/canvas/` for node WebViews; see `docs/configuration.md` (`canvasHost`).
- **Remote use**: SSH tunnel or tailnet/VPN; see `docs/remote.md` and `docs/discovery.md`.

## Features (high level)

- 📱 **WhatsApp Integration** — Uses Baileys for WhatsApp Web protocol
- ✈️ **Telegram Bot** — DMs + groups via grammY
- 🎮 **Discord Bot** — DMs + guild channels via discord.js
- 💬 **iMessage** — Local imsg CLI integration (macOS)
- 🤖 **Agent bridge** — Pi (RPC mode) with tool streaming
- 🔐 **Subscription auth** — Anthropic (Claude Pro/Max) + OpenAI (ChatGPT/Codex) via OAuth
- 💬 **Sessions** — Direct chats collapse into shared `main` (default); groups are isolated
- 👥 **Group Chat Support** — Mention-based by default; owner can toggle `/activation always|mention`
- 📎 **Media Support** — Send and receive images, audio, documents
- 🎤 **Voice notes** — Optional transcription hook
- 🖥️ **WebChat + macOS app** — Local UI + menu bar companion for ops and voice wake
- 📱 **iOS node** — Pairs as a node and exposes a Canvas surface
- 📱 **Android node** — Pairs as a node and exposes Canvas + Chat + Camera

Note: legacy Claude/Codex/Gemini/Opencode paths have been removed; Pi is the only coding-agent path.

## Quick start

Runtime requirement: **Node ≥ 22**.

```bash
# From source (recommended while the npm package is still settling)
pnpm install
pnpm build
pnpm link --global

# Pair WhatsApp Web (shows QR)
clawdbot login

# Run the Gateway (leave running)
clawdbot gateway --port 18789
```

Multi-instance quickstart (optional):

```bash
CLAWDBOT_CONFIG_PATH=~/.clawdbot/a.json \
CLAWDBOT_STATE_DIR=~/.clawdbot-a \
clawdbot gateway --port 19001
```

Send a test message (requires a running Gateway):

```bash
clawdbot send --to +15555550123 --message "Hello from CLAWDBOT"
```

## Configuration (optional)

Config lives at `~/.clawdbot/clawdbot.json`.

- If you **do nothing**, CLAWDBOT uses the bundled Pi binary in RPC mode with per-sender sessions.
- If you want to lock it down, start with `whatsapp.allowFrom` and (for groups) mention rules.

Example:

```json5
{
  whatsapp: {
    allowFrom: ["+15555550123"],
    groups: { "*": { requireMention: true } }
  },
  routing: { groupChat: { mentionPatterns: ["@clawd"] } }
}
```

## Docs

- Start here:
  - [Docs hubs (all pages linked)](./hubs.md)
  - [FAQ](./faq.md) ← *common questions answered*
  - [Configuration](./configuration.md)
  - [Nix mode](./nix.md)
  - [Clawd personal assistant setup](./clawd.md)
  - [Skills](./skills.md)
  - [Skills config](./skills-config.md)
  - [Workspace templates](./templates/AGENTS.md)
  - [RPC adapters](./rpc.md)
  - [Gateway runbook](./gateway.md)
  - [Nodes (iOS/Android)](./nodes.md)
  - [Web surfaces (Control UI)](./web.md)
  - [Discovery + transports](./discovery.md)
  - [Remote access](./remote.md)
- Providers and UX:
  - [WebChat](./webchat.md)
  - [Control UI (browser)](./control-ui.md)
  - [Telegram](./telegram.md)
  - [Discord](./discord.md)
  - [iMessage](./imessage.md)
  - [Groups](./groups.md)
  - [WhatsApp group messages](./group-messages.md)
  - [Media: images](./images.md)
  - [Media: audio](./audio.md)
- Companion apps:
  - [macOS app](./macos.md)
  - [iOS app](./ios.md)
  - [Android app](./android.md)
  - [Windows app](./windows.md)
  - [Linux app](./linux.md)
- Ops and safety:
  - [Sessions](./session.md)
  - [Cron + wakeups](./cron.md)
  - [Security](./security.md)
  - [Troubleshooting](./troubleshooting.md)

## The name

**CLAWDBOT = CLAW + TARDIS** — because every space lobster needs a time-and-space machine.

---

*"We're all just playing with our own prompts."* — an AI, probably high on tokens

## Credits

- **Peter Steinberger** ([@steipete](https://twitter.com/steipete)) — Creator, lobster whisperer
- **Mario Zechner** ([@badlogicc](https://twitter.com/badlogicgames)) — Pi creator, security pen-tester
- **Clawd** — The space lobster who demanded a better name

## Core Contributors

- **Maxim Vovshin** (@Hyaxia, 36747317+Hyaxia@users.noreply.github.com) — Blogwatcher skill
- **Nacho Iacovino** (@nachoiacovino, nacho.iacovino@gmail.com) — Location parsing (Telegram + WhatsApp)

## License

MIT — Free as a lobster in the ocean 🦞

---

*"We're all just playing with our own prompts."* — An AI, probably high on tokens
