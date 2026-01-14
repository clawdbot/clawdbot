---
summary: "Compaction modes and configuration"
read_when:
  - You want to configure compaction summarization behavior
  - You are tuning compaction settings in clawdbot.json
---
# Compaction

Compaction summarizes older session history so the conversation stays within the model context window. The summary is stored in the session JSONL history and combined with the most recent messages.

## Modes

`agents.defaults.compaction.mode` controls how summaries are generated.

- `default` (default): use the built-in compaction summarizer.
- `safeguard`: uses a chunked summarization pass to avoid context overflow for very long histories. If chunked summarization fails, Clawdbot falls back to a minimal summary plus file-operation metadata.

## Configuration

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000
        }
      }
    }
  }
}
```

## Related docs

- [Context window + compaction behavior](/concepts/compaction)
- [Gateway configuration reference](/gateway/configuration)
