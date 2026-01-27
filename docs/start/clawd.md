---
summary: "End-to-end guide for running Moltbot as a personal assistant with safety cautions"
read_when:
  - Onboarding a new assistant instance
  - Reviewing safety/permission implications
---
# Building a personal assistant with Moltbot (Clawd-style)

Moltbot is a WhatsApp + Telegram + Discord + iMessage gateway for **Pi** agents. Plugins add Mattermost. This guide is the "personal assistant" setup: one dedicated WhatsApp number that behaves like your always-on agent.

## ⚠️ Safety first

You’re putting an agent in a position to:
- run commands on your machine (depending on your Pi tool setup)
- read/write files in your workspace
- send messages back out via WhatsApp/Telegram/Discord/Mattermost (plugin)

Start conservative:
- Always set `channels.whatsapp.allowFrom` (never run open-to-the-world on your personal Mac).
- Use a dedicated WhatsApp number for the assistant.
- Heartbeats now default to every 30 minutes. Disable until you trust the setup by setting `agents.defaults.heartbeat.every: "0m"`.

## Prerequisites

- Node **22+**
- Moltbot available on PATH (recommended: global install)
- A second phone number (SIM/eSIM/prepaid) for the assistant

```bash
npm install -g moltbot@latest
# or: pnpm add -g moltbot@latest
```

From source (development):

```bash
git clone https://github.com/moltbot/moltbot.git
cd moltbot
pnpm install
pnpm ui:build # auto-installs UI deps on first run
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
                              │  (moltbot)      │
                              │    Pi agent     │
                              └─────────────────┘
```

If you link your personal WhatsApp to Moltbot, every message to you becomes “agent input”. That’s rarely what you want.

## 5-minute quick start

1) Pair WhatsApp Web (shows QR; scan with the assistant phone):

```bash
moltbot channels login
```

2) Start the Gateway (leave it running):

```bash
moltbot gateway --port 18789
```

3) Put a minimal config in `~/.clawdbot/moltbot.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } }
}
```

Now message the assistant number from your allowlisted phone.

When onboarding finishes, we auto-open the dashboard with your gateway token and print the tokenized link. To reopen later: `moltbot dashboard`.

## Give the agent a workspace (AGENTS)

Clawd reads operating instructions and “memory” from its workspace directory.

By default, Moltbot uses `~/clawd` as the agent workspace, and will create it (plus starter `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`) automatically on setup/first agent run. `BOOTSTRAP.md` is only created when the workspace is brand new (it should not come back after you delete it).

Tip: treat this folder like Clawd’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up. If git is installed, brand-new workspaces are auto-initialized.

```bash
moltbot setup
```

Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)
Memory workflow: [Memory](/concepts/memory)

Optional: choose a different workspace with `agents.defaults.workspace` (supports `~`).

```json5
{
  agent: {
    workspace: "~/clawd"
  }
}
```

If you already ship your own workspace files from a repo, you can disable bootstrap file creation entirely:

```json5
{
  agent: {
    skipBootstrap: true
  }
}
```

## The config that turns it into “an assistant”

Moltbot defaults to a good assistant setup, but you’ll usually want to tune:
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
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }
      }
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
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080
    }
  }
}
```

## Sessions and memory

- Session files: `~/.clawdbot/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Session metadata (token usage, last route, etc): `~/.clawdbot/agents/<agentId>/sessions/sessions.json` (legacy: `~/.clawdbot/sessions/sessions.json`)
- `/new` or `/reset` starts a fresh session for that chat (configurable via `resetTriggers`). If sent alone, the agent replies with a short hello to confirm the reset.
- `/compact [instructions]` compacts the session context and reports the remaining context budget.

## Heartbeats (proactive mode)

By default, Moltbot runs a heartbeat every 30 minutes with the prompt:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Set `agents.defaults.heartbeat.every: "0m"` to disable.

- If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown headers like `# Heading`), Moltbot skips the heartbeat run to save API calls.
- If the file is missing, the heartbeat still runs and the model decides what to do.
- If the agent replies with `HEARTBEAT_OK` (optionally with short padding; see `agents.defaults.heartbeat.ackMaxChars`), Moltbot suppresses outbound delivery for that heartbeat.
- Heartbeats run full agent turns — shorter intervals burn more tokens.

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

Moltbot extracts these and sends them as media alongside the text.

## Operations checklist

```bash
moltbot status          # local status (creds, sessions, queued events)
moltbot status --all    # full diagnosis (read-only, pasteable)
moltbot status --deep   # adds gateway health probes (Telegram + Discord)
moltbot health --json   # gateway health snapshot (WS)
```

Logs live under `/tmp/moltbot/` (default: `moltbot-YYYY-MM-DD.log`).

## Next steps

- WebChat: [WebChat](/web/webchat)
- Gateway ops: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS menu bar companion: [Moltbot macOS app](/platforms/macos)
- iOS node app: [iOS app](/platforms/ios)
- Android node app: [Android app](/platforms/android)
- Windows status: [Windows (WSL2)](/platforms/windows)
- Linux status: [Linux app](/platforms/linux)
- Security: [Security](/gateway/security)
