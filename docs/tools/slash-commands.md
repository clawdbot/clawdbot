---
summary: "Slash commands: text vs native, config, and supported commands"
read_when:
  - Using or configuring chat commands
  - Debugging command routing or permissions
---
# Slash commands

Commands are handled by the Gateway. Send them as a **standalone** message that starts with `/`.
Inline text like `hello /status` is ignored for commands.

Directives (`/think`, `/verbose`, `/reasoning`, `/elevated`) are parsed even when inline and are stripped from the message before the model sees it.

## Config

```json5
{
  commands: {
    native: false,
    text: true,
    restart: false,
    useAccessGroups: true
  }
}
```

- `commands.text` (default `true`) enables parsing `/...` in chat messages.
  - On surfaces without native commands (WhatsApp/WebChat/Signal/iMessage), text commands still work even if you set this to `false`.
- `commands.native` (default `false`) registers native commands on Discord/Slack/Telegram.
  - `false` clears previously registered commands on Discord/Telegram at startup.
  - Slack commands are managed in the Slack app and are not removed automatically.
- `commands.useAccessGroups` (default `true`) enforces allowlists/policies for commands.

## Command list

Text + native (when enabled):
- `/help`
- `/commands`
- `/status`
- `/status` (show current status; includes a short usage line when available)
- `/usage` (alias: `/status`)
- `/debug show|set|unset|reset` (runtime overrides, owner-only)
- `/cost on|off` (toggle per-response usage line)
- `/stop`
- `/restart`
- `/activation mention|always` (groups only)
- `/send on|off|inherit` (owner-only)
- `/reset` or `/new`
- `/think <level>` (aliases: `/thinking`, `/t`)
- `/verbose on|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; `stream` = Telegram draft only)
- `/elevated on|off` (alias: `/elev`)
- `/model <name>` (alias: `/models`; or `/<alias>` from `agents.defaults.models.*.alias`)
- `/queue <mode>` (plus options like `debounce:2s cap:25 drop:summarize`; send `/queue` to see current settings)

Text-only:
- `/compact [instructions]` (see [/concepts/compaction](/concepts/compaction))

Notes:
- Commands accept an optional `:` between the command and args (e.g. `/think: high`, `/send: on`, `/help:`).
- `/status` and `/usage` show the same status output; for full provider usage breakdown, use `clawdbot status --usage`.
- `/cost` appends per-response token usage; it only shows dollar cost when the model uses an API key (OAuth hides cost).
- `/restart` is disabled by default; set `commands.restart: true` to enable it.
- `/verbose` is meant for debugging and extra visibility; keep it **off** in normal use.
- `/reasoning` (and `/verbose`) are risky in group settings: they may reveal internal reasoning or tool output you did not intend to expose. Prefer leaving them off, especially in group chats.

## Debug overrides

`/debug` lets you set **runtime-only** config overrides (memory, not disk). Owner-only.

Examples:

```
/debug show
/debug set messages.responsePrefix="[clawdbot]"
/debug set whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notes:
- Overrides apply immediately to new config reads, but do **not** write to `clawdbot.json`.
- Use `/debug reset` to clear all overrides and return to the on-disk config.

## Surface notes

- **Text commands** run in the normal chat session (DMs share `main`, groups have their own session).
- **Native commands** use isolated sessions: `discord:slash:<userId>`, `slack:slash:<userId>`, `telegram:slash:<userId>`.
- **`/stop`** targets the active chat session so it can abort the current run.
- **Slack:** `slack.slashCommand` is still supported for a single `/clawd`-style command. If you enable `commands.native`, you must create one Slack slash command per built-in command (same names as `/help`).
