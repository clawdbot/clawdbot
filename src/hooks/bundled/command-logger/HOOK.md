---
name: command-logger
description: "Log all command events to a centralized audit file"
homepage: https://docs.openclaw.ai/automation/hooks#command-logger
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["command"],
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Command Logger Hook

Logs all command events (`/new`, `/reset`, `/stop`, etc.) to a centralized audit log file for debugging and monitoring purposes.

## What It Does

Every time you issue a command to the agent:

1. **Captures event details** - Command action, timestamp, session key, sender ID, source
2. **Appends to log file** - Writes a JSON line to `~/.openclaw/logs/commands.log`
3. **Silent operation** - Runs in the background without user notifications

## Output Format

Log entries are written in JSONL (JSON Lines) format:

```json
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

## Use Cases

- **Debugging**: Track when commands were issued and from which source
- **Auditing**: Monitor command usage across different channels
- **Analytics**: Analyze command patterns and frequency
- **Troubleshooting**: Investigate issues by reviewing command history

## Log File Location

`~/.openclaw/logs/commands.log`

## Requirements

No requirements - this hook works out of the box on all platforms.

## Configuration

No configuration needed. The hook automatically:

- Creates the log directory if it doesn't exist
- Appends to the log file (doesn't overwrite)
- Handles errors silently without disrupting command execution

## Disabling

To disable this hook:

```bash
openclaw hooks disable command-logger
```

Or via config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

## Log Rotation

The hook does not automatically rotate logs. To manage log size, you can:

1. **Manual rotation**:

   ```bash
   mv ~/.openclaw/logs/commands.log ~/.openclaw/logs/commands.log.old
   ```

2. **Use logrotate** (Linux):
   Create `/etc/logrotate.d/openclaw`:
   ```
   /home/username/.openclaw/logs/commands.log {
       weekly
       rotate 4
       compress
       missingok
       notifempty
   }
   ```

## Viewing Logs

View recent commands:

```bash
tail -n 20 ~/.openclaw/logs/commands.log
```

Pretty-print with jq:

```bash
cat ~/.openclaw/logs/commands.log | jq .
```

Filter by action:

```bash
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```
