---
summary: "How OpenClaw summarizes long conversations to stay within model limits"
read_when:
  - You want to understand auto-compaction and /compact
  - You are debugging long sessions hitting context limits
title: "Compaction"
---

Every model has a context window -- the maximum number of tokens it can process.
When a conversation approaches that limit, OpenClaw **compacts** older messages
into a summary so the chat can continue.

## How it works

1. Older conversation turns are summarized into a compact entry.
2. The summary is saved in the session transcript.
3. Recent messages are kept intact.

When OpenClaw splits history into compaction chunks, it keeps assistant tool
calls paired with their matching `toolResult` entries. If a split point lands
inside a tool block, OpenClaw moves the boundary so the pair stays together and
the current unsummarized tail is preserved.

The full conversation history stays on disk. Compaction only changes what the
model sees on the next turn.

## Auto-compaction

Auto-compaction is on by default. It runs when the session nears the context
limit, or when the model returns a context-overflow error (in which case
OpenClaw compacts and retries). Typical overflow signatures include
`request_too_large`, `context length exceeded`, `input exceeds the maximum
number of tokens`, `input token count exceeds the maximum number of input
tokens`, `input is too long for the model`, and `ollama error: context length
exceeded`.

<Info>
Before compacting, OpenClaw automatically reminds the agent to save important
notes to [memory](/concepts/memory) files. This prevents context loss.
</Info>

Use the `agents.defaults.compaction` setting in your `openclaw.json` to configure compaction behavior (mode, target tokens, etc.).
Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). You can override this with `identifierPolicy: "off"` or provide custom text with `identifierPolicy: "custom"` and `identifierInstructions`.

You can optionally specify a different model for compaction summarization via `agents.defaults.compaction.model`. This is useful when your primary model is a local or small model and you want compaction summaries produced by a more capable model. The override accepts any `provider/model-id` string:

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

This also works with local models, for example a second Ollama model dedicated to summarization or a fine-tuned compaction specialist:

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

When unset, compaction uses the agent’s primary model.

## Pluggable compaction providers

Plugins can register a custom compaction provider via `registerCompactionProvider()` on the plugin API. When a provider is registered and configured, OpenClaw delegates summarization to it instead of the built-in LLM pipeline.

To use a registered provider, set the provider id in your config:

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

Setting a `provider` automatically forces `mode: "safeguard"`. Providers receive the same compaction instructions and identifier-preservation policy as the built-in path, and OpenClaw still preserves recent-turn and split-turn suffix context after provider output. If the provider fails or returns an empty result, OpenClaw falls back to built-in LLM summarization.

## Auto-compaction (default on)

When a session nears or exceeds the model’s context window, OpenClaw triggers auto-compaction and may retry the original request using the compacted context.

You’ll see:

- `🧹 Auto-compaction complete` in verbose mode
- `/status` showing `🧹 Compactions: <count>`

Before compaction, OpenClaw can run a **silent memory flush** turn to store
durable notes to disk. See [Memory](/concepts/memory) for details and config.

## Manual compaction

Type `/compact` in any chat to force a compaction. Add instructions to guide
the summary:

```
/compact Focus on the API design decisions
```

## Using a different model

By default, compaction uses your agent's primary model. You can use a more
capable model for better summaries:

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "openrouter/anthropic/claude-sonnet-4-6",
      },
    },
  },
}
```

## Compaction notices

By default, compaction runs silently. To show brief notices when compaction
starts and when it completes, enable `notifyUser`:

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

When enabled, the user sees short status messages around each compaction run
(for example, "Compacting context..." and "Compaction complete").

## Compaction vs pruning

|                  | Compaction                    | Pruning                          |
| ---------------- | ----------------------------- | -------------------------------- |
| **What it does** | Summarizes older conversation | Trims old tool results           |
| **Saved?**       | Yes (in session transcript)   | No (in-memory only, per request) |
| **Scope**        | Entire conversation           | Tool results only                |

[Session pruning](/concepts/session-pruning) is a lighter-weight complement that
trims tool output without summarizing.

## Troubleshooting

**Compacting too often?** The model's context window may be small, or tool
outputs may be large. Try enabling
[session pruning](/concepts/session-pruning).

**Context feels stale after compaction?** Use `/compact Focus on <topic>` to
guide the summary, or enable the [memory flush](/concepts/memory) so notes
survive.

**Need a clean slate?** `/new` starts a fresh session without compacting.

For advanced configuration (reserve tokens, identifier preservation, custom
context engines, OpenAI server-side compaction), see the
[Session Management Deep Dive](/reference/session-management-compaction).

## Related

- [Session](/concepts/session) — session management and lifecycle
- [Session Pruning](/concepts/session-pruning) — trimming tool results
- [Context](/concepts/context) — how context is built for agent turns
- [Hooks](/automation/hooks) — compaction lifecycle hooks (before_compaction, after_compaction)
