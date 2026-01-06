---
summary: "End-to-end guide for running Clawdbot as a personal assistant with safety cautions"
read_when:
  - Onboarding a new assistant instance
  - Reviewing safety/permission implications
---
# Building a personal assistant with CLAWDBOT (Clawd-style)

CLAWDBOT is a WhatsApp + Telegram + Discord gateway for **Pi** agents. This guide is the “personal assistant” setup: one dedicated WhatsApp number that behaves like your always-on agent.

## ⚠️ Safety first

You’re putting an agent in a position to:
- run commands on your machine (depending on your Pi tool setup)
- read/write files in your workspace
- send messages back out via WhatsApp/Telegram/Discord

Start conservative:
- Always set `whatsapp.allowFrom` (never run open-to-the-world on your personal Mac).
- Use a dedicated WhatsApp number for the assistant.
- Keep heartbeats disabled until you trust the setup (omit `agent.heartbeat` or set `agent.heartbeat.every: "0m"`).

## Prerequisites

- Node **22+**
- CLAWDBOT available on PATH (recommended during development: from source + global link)
- A second phone number (SIM/eSIM/prepaid) for the assistant

From source (recommended while the npm package is still settling):

```bash
pnpm install
pnpm build
pnpm link --global
```

## The two-phone setup (recommended)

You want this:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-CLAWD   │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (clawdbot)      │
                              │    Pi agent     │
                              └─────────────────┘
```

If you link your personal WhatsApp to CLAWDBOT, every message to you becomes “agent input”. That’s rarely what you want.

## 5-minute quick start

1) Pair WhatsApp Web (shows QR; scan with the assistant phone):

```bash
clawdbot login
```

2) Start the Gateway (leave it running):

```bash
clawdbot gateway --port 18789
```

3) Put a minimal config in `~/.clawdbot/clawdbot.json`:

```json5
{
  whatsapp: {
    allowFrom: ["+15555550123"]
  }
}
```

Now message the assistant number from your allowlisted phone.

## Give the agent a workspace (AGENTS.md)

Clawd reads operating instructions and “memory” from its workspace directory.

By default, Clawdbot uses `~/clawd` as the agent workspace, and will create it (plus starter `AGENTS.md`, `SOUL.md`, `TOOLS.md`) automatically on setup/first agent run.

Tip: treat this folder like Clawd’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up.

```bash
clawdbot setup
```

Optional: choose a different workspace with `agent.workspace` (supports `~`).

```json5
{
  agent: {
    workspace: "~/clawd"
  }
}
```

## The config that turns it into “an assistant”

CLAWDBOT defaults to a good assistant setup, but you’ll usually want to tune:
- persona/instructions in `SOUL.md`
- thinking defaults (if desired)
- heartbeats (once you trust it)

Example:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-5",
    workspace: "~/clawd",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" }
  },
  whatsapp: {
    allowFrom: ["+15555550123"],
    groups: {
      "*": { requireMention: true }
    }
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@clawd", "clawd"]
    }
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    idleMinutes: 10080
  }
}
```

## Sessions and memory

- Session files: `~/.clawdbot/sessions/{{SessionId}}.jsonl`
- Session metadata (token usage, last route, etc): `~/.clawdbot/sessions/sessions.json` (legacy: `~/.clawdbot/sessions.json`)
- `/new` or `/reset` starts a fresh session for that chat (configurable via `resetTriggers`). If sent alone, the agent replies with a short hello to confirm the reset.
- `/compact [instructions]` compacts the session context and reports the remaining context budget.

## Heartbeats (proactive mode)

When `agent.heartbeat.every` is set to a positive interval, CLAWDBOT periodically runs a heartbeat prompt (default: `HEARTBEAT`).

- If the agent replies with `HEARTBEAT_OK` (optionally with short padding; see `agent.heartbeat.ackMaxChars`), CLAWDBOT suppresses outbound delivery for that heartbeat.

```json5
{
  agent: {
    heartbeat: { every: "30m" }
  }
}
```

## Media in and out

Inbound attachments (images/audio/docs) can be surfaced to your command via templates:
- `{{MediaPath}}` (local temp file path)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (if audio transcription is enabled)

Outbound attachments from the agent: include `MEDIA:<path-or-url>` on its own line (no spaces). Example:

```
Here’s the screenshot.
MEDIA:/tmp/screenshot.png
```

CLAWDBOT extracts these and sends them as media alongside the text.

## Operations checklist

```bash
clawdbot status          # local status (creds, sessions, queued events)
clawdbot status --deep   # also probes the running Gateway (WA connect + Telegram)
clawdbot health --json   # gateway health snapshot (WS)
```

Logs live under `/tmp/clawdbot/` (default: `clawdbot-YYYY-MM-DD.log`).

## Next steps

- WebChat: [WebChat](./webchat.md)
- Gateway ops: [Gateway runbook](./gateway.md)
- Cron + wakeups: [Cron + wakeups](./cron.md)
- macOS menu bar companion: [Clawdbot macOS app](./macos.md)
- iOS node app: [iOS app](./ios.md)
- Android node app: [Android app](./android.md)
- Windows status: [Windows app](./windows.md)
- Linux status: [Linux app](./linux.md)
- Security: [Security](./security.md)
