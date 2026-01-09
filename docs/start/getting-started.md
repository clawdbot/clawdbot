---
summary: "Beginner guide: from zero to first message (wizard, auth, providers, pairing)"
read_when:
  - First time setup from zero
  - You want the fastest path from install → onboarding → first message
---

# Getting Started

Goal: go from **zero** → **first working chat** (with sane defaults) as quickly as possible.

Recommended path: use the **CLI onboarding wizard** (`clawdbot onboard`). It sets up:
- model/auth (OAuth recommended)
- gateway settings
- providers (WhatsApp/Telegram/Discord/…)
- pairing defaults (secure DMs)
- workspace bootstrap + skills
- optional background daemon

If you want the deeper reference pages, jump to: [Wizard](/start/wizard), [Setup](/start/setup), [Pairing](/start/pairing), [Security](/gateway/security).

Sandboxing note: `agents.defaults.sandbox.mode: "non-main"` uses `session.mainKey` (default `"main"`),
so group/channel sessions are sandboxed. If you want the main agent to always
run on host, set an explicit per-agent override:

```json
{
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/clawd",
        "sandbox": { "mode": "off" }
      }
    }
  }
}
```

## 0) Prereqs

- Node `>=22`
- `pnpm` (optional; recommended if you build from source)

macOS: if you plan to build the apps, install Xcode / CLT. For the CLI + gateway only, Node is enough.
Windows: use **WSL2** (Ubuntu recommended). WSL2 is strongly recommended; native Windows is untested and more problematic. Install WSL2 first, then run the Linux steps inside WSL. See [Windows (WSL2)](/platforms/windows).

## 1) Install the CLI (recommended)

```bash
npm install -g clawdbot@latest
# or: pnpm add -g clawdbot@latest
```

## 2) Run the onboarding wizard (and install the daemon)

```bash
clawdbot onboard --install-daemon
```

What you’ll choose:
- **Local vs Remote** gateway
- **Auth**: **Anthropic OAuth via Claude CLI setup-token (preferred)**, OpenAI OAuth (recommended), API key (optional), or skip for now
- **Providers**: WhatsApp QR login, Telegram/Discord bot tokens, etc.
- **Daemon**: background install (launchd/systemd; WSL2 uses systemd)
  - **Runtime**: Node (recommended; required for WhatsApp) or Bun (faster, but incompatible with WhatsApp)

Wizard doc: [Wizard](/start/wizard)

### Auth: where it lives (important)

- **Preferred Anthropic path:** install Claude CLI on the gateway host and run `claude setup-token`. The wizard can reuse it, and `clawdbot models status` will sync it into Clawdbot auth profiles.

- OAuth credentials (legacy import): `~/.clawdbot/credentials/oauth.json`
- Auth profiles (OAuth + API keys): `~/.clawdbot/agents/<agentId>/agent/auth-profiles.json`

Headless/server tip: do OAuth on a normal machine first, then copy `oauth.json` to the gateway host.

## 3) Start the Gateway

If you installed the daemon during onboarding, the Gateway should already be running:

```bash
clawdbot daemon status
```

Manual run (foreground):

```bash
clawdbot gateway --port 18789 --verbose
```

Dashboard (local loopback): `http://127.0.0.1:18789/`

⚠️ **WhatsApp + Bun warning:** Baileys (WhatsApp Web library) uses a WebSocket
path that is currently incompatible with Bun and can cause memory corruption on
reconnect. If you use WhatsApp, run the Gateway with **Node** until this is
resolved. Baileys: https://github.com/WhiskeySockets/Baileys · Bun issue:
https://github.com/oven-sh/bun/issues/5951

## 4) Pair + connect your first chat surface

### WhatsApp (QR login)

```bash
clawdbot providers login
```

Scan via WhatsApp → Settings → Linked Devices.

WhatsApp doc: [WhatsApp](/providers/whatsapp)

### Telegram / Discord / others

The wizard can write tokens/config for you. If you prefer manual config, start with:
- Telegram: [Telegram](/providers/telegram)
- Discord: [Discord](/providers/discord)

**Telegram DM tip:** your first DM returns a pairing code. Approve it (see next step) or the bot won’t respond.

## 5) DM safety (pairing approvals)

Default posture: unknown DMs get a short code and messages are not processed until approved.
If your first DM gets no reply, approve the pairing:

```bash
clawdbot pairing list --provider whatsapp
clawdbot pairing approve --provider whatsapp <code>
```

Pairing doc: [Pairing](/start/pairing)

## From source (development)

If you’re hacking on Clawdbot itself, run from source:

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
pnpm clawdbot onboard --install-daemon
```

Gateway (from this repo):

```bash
node dist/entry.js gateway --port 18789 --verbose
```

## 7) Verify end-to-end

In a new terminal:

```bash
clawdbot health
clawdbot message send --to +15555550123 --message "Hello from Clawdbot"
```

If `health` shows “no auth configured”, go back to the wizard and set OAuth/key auth — the agent won’t be able to respond without it.

Local probe tip: `clawdbot status --deep` runs provider checks without needing a gateway connection.
Gateway snapshot: `clawdbot providers status` shows what the gateway reports (use `status --deep` for local-only probes).

## Next steps (optional, but great)

- macOS menu bar app + voice wake: [macOS app](/platforms/macos)
- iOS/Android nodes (Canvas/camera/voice): [Nodes](/nodes)
- Remote access (SSH tunnel / Tailscale Serve): [Remote access](/gateway/remote) and [Tailscale](/gateway/tailscale)
