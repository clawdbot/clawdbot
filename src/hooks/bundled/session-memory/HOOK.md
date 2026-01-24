---
name: session-memory
description: "Save session context to memory when /new command is issued"
homepage: https://docs.clawd.bot/hooks#session-memory
metadata:
  {
    "clawdbot":
      {
        "emoji": "💾",
        "events": ["command:new"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Clawdbot" }],
      },
  }
---

# Session Memory Hook

Automatically saves session context to your workspace memory when you issue the `/new` command.

## What It Does

When you run `/new` to start a fresh session:

1. **Reads the full session transcript** - Parses the JSONL session file
2. **Filters out noise** - Removes heartbeats, NO_REPLY, tool blocks, and system messages
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug
4. **Summarizes via LLM** - Creates a structured summary of the session content
5. **Saves to memory** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`

## Summary Format

The LLM generates a structured summary including:

- **Topics**: Main subjects discussed
- **Decisions**: Key decisions or conclusions reached
- **Outcomes**: What was accomplished or resolved
- **Open Items**: Unfinished tasks or questions (if any)

## Output Format

Memory files are created with the following structure:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram

## Summary

**Topics**: API integration, deployment pipeline

**Decisions**: 
- Use REST over GraphQL for the initial implementation
- Deploy to staging before production

**Outcomes**:
- Created initial endpoint scaffolding
- Configured CI/CD workflow

**Open Items**:
- Need to finalize auth strategy with the team
```

## Filename Examples

The LLM generates descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session
- `2026-01-16-1430.md` - Fallback timestamp if slug generation fails

## Noise Filtering

The following are automatically filtered out:

- Heartbeat prompts (`Read HEARTBEAT.md...`)
- Heartbeat responses (`HEARTBEAT_OK`)
- Silent replies (`NO_REPLY`)
- System messages
- Slash commands
- Empty messages

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during onboarding)

The hook uses your configured LLM provider to generate summaries, so it works with any provider (Anthropic, OpenAI, etc.).

## Configuration

No additional configuration required. The hook automatically:

- Uses your workspace directory (`~/clawd` by default)
- Uses your configured LLM for slug and summary generation
- Falls back to raw content if LLM summarization fails
- Falls back to timestamp slugs if slug generation fails

## Disabling

To disable this hook:

```bash
clawdbot hooks disable session-memory
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

## Token Usage

This hook makes two LLM calls when `/new` is issued:

1. **Slug generation**: ~2k token context, small output
2. **Summary generation**: Up to 50k token context, ~500 token output

If you want to minimize token usage, you can disable the hook and manually run `/compact` before `/new` instead.
