---
summary: "How OpenClaw summarizes long conversations to stay within model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

Every model has a context window: the maximum number of tokens it can process. When a conversation approaches that limit, OpenClaw **compacts** older messages into a summary so the chat can continue.

## How it works

1. Older conversation turns are summarized into a compact entry.
2. The summary is saved in the session transcript.
3. Recent messages are kept intact.

When OpenClaw splits history into compaction chunks, it keeps assistant tool calls paired with their matching `toolResult` entries. If a split point lands inside a tool block, OpenClaw moves the boundary so the pair stays together and the current unsummarized tail is preserved.

The full conversation history stays on disk. Compaction only changes what the model sees on the next turn.

## Auto-compaction

Auto-compaction is on by default. It runs when the session nears the context limit, or when the model returns a context-overflow error (in which case OpenClaw compacts and retries).

You will see:

- `🧹 Auto-compaction complete` in verbose mode.
- `/status` showing `🧹 Compactions: <count>`.

<Info>
Before compacting, OpenClaw automatically reminds the agent to save important notes to [memory](/concepts/memory) files. This prevents context loss.
</Info>

<AccordionGroup>
  <Accordion title="Recognized overflow signatures">
    OpenClaw detects context overflow from these provider error patterns:

    - `request_too_large`
    - `context length exceeded`
    - `input exceeds the maximum number of tokens`
    - `input token count exceeds the maximum number of input tokens`
    - `input is too long for the model`
    - `ollama error: context length exceeded`

  </Accordion>
</AccordionGroup>

## Manual compaction

Type `/compact` in any chat to force a compaction. Add instructions to guide the summary:

```
/compact Focus on the API design decisions
```

When `agents.defaults.compaction.keepRecentTokens` is set, manual compaction honors that Pi cut-point and keeps the recent tail in rebuilt context. Without an explicit keep budget, manual compaction behaves as a hard checkpoint and continues from the new summary alone.

## Configuration

Configure compaction under `agents.defaults.compaction` in your `openclaw.json`. The most common knobs are listed below; for the full reference, see [Session management deep dive](/reference/session-management-compaction).

### Using a different model

By default, compaction uses the agent's primary model. Set `agents.defaults.compaction.model` to delegate summarization to a more capable or specialized model. The override accepts any `provider/model-id` string:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-6"
      }
    }
  }
}
```

This works with local models too, for example a second Ollama model dedicated to summarization:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

When unset, compaction starts with the active session model. If summarization fails with a model-fallback-eligible provider error, OpenClaw retries that compaction attempt through the session's existing model fallback chain. The fallback choice is temporary and is not written back to session state. An explicit `agents.defaults.compaction.model` override remains exact and does not inherit the session fallback chain.

### Identifier preservation

Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). Override with `identifierPolicy: "off"` to disable, or `identifierPolicy: "custom"` plus `identifierInstructions` for custom guidance.

### Active transcript byte guard

When `agents.defaults.compaction.maxActiveTranscriptBytes` is set, OpenClaw triggers normal local compaction before a run if the active JSONL reaches that size. This is useful for long-running sessions where provider-side context management may keep model context healthy while the local transcript keeps growing. It does not split raw JSONL bytes; it asks the normal compaction pipeline to create a semantic summary.

<Warning>
The byte guard requires `truncateAfterCompaction: true`. Without transcript rotation, the active file would not shrink and the guard remains inactive.
</Warning>

### Successor transcripts

When `agents.defaults.compaction.truncateAfterCompaction` is enabled, OpenClaw does not rewrite the existing transcript in place. It creates a new active successor transcript from the compaction summary, preserved state, and unsummarized tail, then keeps the previous JSONL as the archived checkpoint source.
Successor transcripts also drop exact duplicate long user turns that arrive
inside a short retry window, so channel retry storms are not carried into the
next active transcript after compaction.

Pre-compaction checkpoints are retained only while they stay below OpenClaw's
checkpoint size cap; oversized active transcripts still compact, but OpenClaw
skips the large debug snapshot instead of doubling disk usage.

### Compaction notices

By default, compaction runs silently. Set `notifyUser` to show brief status messages when compaction starts and completes:

```json5
{
  agents: {
    defaults: {
      compaction: {
        notifyUser: true,
      },
    },
  },
}
```

### Memory flush

Before compaction, OpenClaw can run a **silent memory flush** turn to store durable notes to disk. Set `agents.defaults.compaction.memoryFlush.model` when this housekeeping turn should use a local model instead of the active conversation model:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

The memory-flush model override is exact and does not inherit the active session fallback chain. See [Memory](/concepts/memory) for details and config.

## Pluggable compaction providers

Plugins can register a custom compaction provider via `registerCompactionProvider()` on the plugin API. When a provider is registered and configured, OpenClaw delegates summarization to it instead of the built-in LLM pipeline.

To use a registered provider, set its id in your config:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "provider": "my-provider"
      }
    }
  }
}
```

Setting a `provider` automatically forces `mode: "safeguard"`. Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and OpenClaw still preserves recent-turn and split-turn suffix context after provider output.

<Note>
If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization.
</Note>

## Compaction vs pruning

|                  | Compaction                    | Pruning                          |
| ---------------- | ----------------------------- | -------------------------------- |
| **What it does** | Summarizes older conversation | Trims old tool results           |
| **Saved?**       | Yes (in session transcript)   | No (in-memory only, per request) |
| **Scope**        | Entire conversation           | Tool results only                |

[Session pruning](/concepts/session-pruning) is a lighter-weight complement that trims tool output without summarizing.

## Troubleshooting

**Compacting too often?** The model's context window may be small, or tool outputs may be large. Try enabling [session pruning](/concepts/session-pruning).

**Context feels stale after compaction?** Use `/compact Focus on <topic>` to guide the summary, or enable the [memory flush](/concepts/memory) so notes survive.

**Need a clean slate?** `/new` starts a fresh session without compacting.

For advanced configuration (reserve tokens, identifier preservation, custom context engines, OpenAI server-side compaction), see the [Session management deep dive](/reference/session-management-compaction).

## Related

- [Session](/concepts/session): session management and lifecycle.
- [Session pruning](/concepts/session-pruning): trimming tool results.
- [Context](/concepts/context): how context is built for agent turns.
- [Hooks](/automation/hooks): compaction lifecycle hooks (`before_compaction`, `after_compaction`).
