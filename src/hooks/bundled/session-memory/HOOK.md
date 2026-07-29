---
name: session-memory
description: "Save session context to memory when a session rolls over"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["session:end"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to workspace memory when a session rolls over.

## What It Does

When a session rolls over because of `/new`, `/reset`, the daily boundary, or idle expiry:

1. **Finds the ended session** - Uses the typed `session_end` lifecycle payload to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Chooses filename slug** - Uses a local timestamp by default, or an LLM-generated description when `llmSlug` is enabled
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-HHMM.md` in the background

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 EST

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Reason**: daily
```

## Filename Examples

Timestamp slugs are the default so session rollover stays fast:

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

| Option     | Type    | Default       | Description                                                                                 |
| ---------- | ------- | ------------- | ------------------------------------------------------------------------------------------- |
| `messages` | number  | 15            | Number of user/assistant messages to include in the memory file                             |
| `llmSlug`  | boolean | false         | Use your configured model to generate descriptive filename slugs instead of timestamp slugs |
| `model`    | string  | agent default | Configured alias, bare model ID on the default provider, or `provider/model` override       |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25,
          "llmSlug": true,
          "model": "sonnet"
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses timestamp slugs by default so rollover stays fast
- Runs memory capture in the background so session startup is not delayed
- Uses your configured LLM for slug generation only when `llmSlug` is `true`
- Resolves configured aliases such as `sonnet`; bare model IDs use the agent's default provider, while `provider/model` selects another provider
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
