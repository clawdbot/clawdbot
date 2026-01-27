---
name: session-memory
description: "Save session context to memory when /new command is issued"
homepage: https://docs.molt.bot/hooks#session-memory
metadata:
  {
    "moltbot":
      {
        "emoji": "💾",
        "events": ["command:new"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Moltbot" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue the `/new` command.

## What It Does

When you run `/new` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last 15 lines of conversation from the session
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug based on conversation content
4. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`
5. **Sends confirmation** - Notifies you with the file path

## Output Format

Memory files are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

## Filename Examples

The LLM generates descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session
- `2026-01-16-1430.md` - Fallback timestamp if slug generation fails

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

No additional configuration required. The hook automatically:

- Uses your workspace directory (`~/clawd` by default)
- Uses your configured LLM for slug generation
- Falls back to timestamp slugs if LLM is unavailable

## Disabling

To disable this hook:

```bash
moltbot hooks disable session-memory
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
