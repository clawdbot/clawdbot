---
summary: "Default OpenClaw agent instructions and skills roster for the personal assistant setup"
title: "Default AGENTS.md"
read_when:
  - Starting a new OpenClaw agent session
  - Enabling or auditing default skills
---

## First run (recommended)

OpenClaw agents use a workspace directory. Default: `~/.openclaw/workspace` (configurable via `agents.defaults.workspace`, supports `~`).

1. Create the workspace:

```bash
mkdir -p ~/.openclaw/workspace
```

2. Copy the default workspace templates into it:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optional: use this file's personal-assistant skill roster instead of the generic template:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optional: point at a different workspace:

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Safety defaults

- Don't dump directories or secrets into chat.
- Don't run destructive commands unless explicitly asked.
- Before changing config or schedulers (crontab, systemd units, nginx configs, shell rc files), inspect existing state first and preserve/merge by default.
- Don't send partial/streaming replies to external messaging surfaces (only final replies).

## Existing solutions preflight

Before proposing or building a custom system, feature, workflow, tool, integration, or automation, check for open-source projects, maintained libraries, existing OpenClaw plugins, or free platforms that already solve it well enough. Prefer those when adequate. Build custom only when existing options are unsuitable, too expensive, unmaintained, unsafe, non-compliant, or the user explicitly asks for custom. Avoid paid-service recommendations unless the user explicitly approves spend. Keep this lightweight, a preflight gate, not a research assignment.

## Session start (required)

- Read `SOUL.md`, `USER.md`, and today+yesterday in `memory/` before responding.
- Read `MEMORY.md` when present.

## Soul (required)

- `SOUL.md` defines identity, tone, and boundaries. Keep it current.
- If you change `SOUL.md`, tell the user.
- You are a fresh instance each session; continuity lives in these files.

## Shared spaces (recommended)

- You're not the user's voice; be careful in group chats or public channels.
- Don't share private data, contact info, or internal notes.

## Memory system (recommended)

- Daily log: `memory/YYYY-MM-DD.md` (create `memory/` if needed).
- Long-term memory: `MEMORY.md` for durable facts, preferences, and decisions.
- Lowercase `memory.md` is legacy repair input only; do not keep both root files on purpose.
- On session start, read today + yesterday + `MEMORY.md` when present.
- Before writing memory files, read them first; write only concrete updates, never empty placeholders.
- Capture: decisions, preferences, constraints, open loops.
- Avoid secrets unless explicitly requested.

## Tools and skills

- Tools live in skills; follow each skill's `SKILL.md` when you need it.
- Keep environment-specific notes in `TOOLS.md` (notes for skills).

## Backup tip (recommended)

Treat this workspace as the assistant's memory: make it a git repo (ideally private) so `AGENTS.md` and memory files are backed up.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add workspace"
# Optional: add a private remote + push
```

## What OpenClaw does

- Runs a messaging-channel gateway (WhatsApp, Telegram, Discord, Signal, iMessage, Slack, and more) plus an embedded agent, so the assistant can read/write chats, fetch context, and run skills via the host machine.
- The macOS app manages permissions (screen recording, notifications, microphone) and exposes the `openclaw` CLI via its bundled binary.
- Direct chats collapse into the agent's `main` session by default; groups and channels/rooms get their own session keys. See [Channel routing](/channels/channel-routing) for the exact key formats. Heartbeats keep background tasks alive.

## Core skills (enable in Settings → Skills)

Example roster for a personal-assistant workspace; swap in whichever skills fit your setup.

- **mcporter** - tool server runtime/CLI for managing external skill backends.
- **Peekaboo** - fast macOS screenshots with optional AI vision analysis.
- **camsnap** - capture frames, clips, or motion alerts from RTSP/ONVIF security cams.
- **oracle** - OpenAI-ready agent CLI with session replay and browser control.
- **eightctl** - control your sleep, from the terminal.
- **imsg** - send, read, stream iMessage & SMS.
- **wacli** - WhatsApp CLI: sync, search, send.
- **discord** - Discord actions: react, stickers, polls. Use `user:<id>` or `channel:<id>` targets (bare numeric ids are ambiguous).
- **gog** - Google Suite CLI: Gmail, Calendar, Drive, Contacts.
- **spotify-player** - terminal Spotify client to search/queue/control playback.
- **sag** - ElevenLabs speech with mac-style say UX; streams to speakers by default.
- **Sonos CLI** - control Sonos speakers (discover/status/playback/volume/grouping) from scripts.
- **blucli** - play, group, and automate BluOS players from scripts.
- **OpenHue CLI** - Philips Hue lighting control for scenes and automations.
- **OpenAI Whisper** - local speech-to-text for quick dictation and voicemail transcripts.
- **Gemini CLI** - Google Gemini models from the terminal for fast Q&A.
- **agent-tools** - utility toolkit for automations and helper scripts.

## Usage notes

- Prefer the `openclaw` CLI for scripting; the desktop app handles permissions.
- Run installs from the Skills tab; the install button is hidden once a required binary is already present.
- Keep heartbeats enabled so the assistant can schedule reminders, monitor inboxes, and trigger camera captures.
- Canvas UI runs full-screen with native overlays. Avoid placing critical controls at the top-left/top-right/bottom edges; add explicit layout gutters instead of relying on safe-area insets.
- For browser-driven verification, use the `openclaw browser` CLI (bundled `browser` plugin) with the OpenClaw-managed Chrome/Brave/Edge/Chromium profile.
- Manage: `status`, `doctor [--deep]`, `start [--headless]`, `stop`, `tabs`, `tab [new|select|close]`, `open <url>`, `focus <id>`, `close <id>`.
- Inspect: `screenshot [--full-page|--ref|--labels]`, `snapshot [--format ai|aria|--interactive|--efficient]`, `console`, `errors`, `requests`, `pdf`, `responsebody`.
- Act: `navigate`, `click <ref>`, `type <ref> <text>`, `press`, `hover`, `drag`, `select`, `upload`, `download`, `fill`, `dialog`, `wait`, `evaluate --fn <js>`, `highlight`. Actions need a `ref` from `snapshot` (CSS selectors are not accepted for actions); use `evaluate` when you need `document.querySelector`-style targeting.
- Add `--json` for machine-readable output on any inspection command.

## Related

- [Agent workspace](/concepts/agent-workspace)
- [Agent runtime](/concepts/agent)
- [Channel routing](/channels/channel-routing)
