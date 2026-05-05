---
name: session-memory
description: "Save session context to memory when /new or /reset command is issued"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue `/new` or `/reset`.

## What It Does

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Chooses filename slug** - Uses a local timestamp by default, or an LLM-generated description when `llmSlug` is enabled
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-HHMM.md` by default without delaying the `/new` or `/reset` reply

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 EST

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

## Filename Examples

Timestamp slugs are the default so `/new` and `/reset` stay fast on message channels:

- `2026-01-16-1430.md` - Default local timestamp slug

With `llmSlug: true`, the configured model can generate descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)

When `llmSlug` is enabled, the hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

The hook supports optional configuration:

| Option     | Type    | Default | Description                                                                                 |
| ---------- | ------- | ------- | ------------------------------------------------------------------------------------------- |
| `messages` | number  | 15      | Number of user/assistant messages to include in the memory file                             |
| `llmSlug`  | boolean | false   | Use your configured model to generate descriptive filename slugs instead of timestamp slugs |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "llmSlug": true
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses timestamp slugs by default so `/new` and `/reset` stay fast on message channels
- Runs memory capture in the background so reset acknowledgements can return immediately
- Uses your configured LLM for slug generation only when `llmSlug` is `true`
- Falls back to timestamp slugs if LLM slug generation is unavailable

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-memory
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
