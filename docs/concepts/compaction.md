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

OpenClaw keeps assistant tool calls paired with their matching `toolResult` entries when it picks a compaction split point. If the point lands inside a tool block, OpenClaw moves the boundary so the pair stays together and the current unsummarized tail is preserved.

The built-in summarizer accounts for Chinese, Japanese, and Korean (CJK) characters in both message text and tool arguments when estimating chunk sizes. These budgets are approximate; a tool call and its results stay together even when that group exceeds a chunk target.

The full conversation history stays on disk. Compaction only changes what the model sees on the next turn.

Built-in summarization receives text, not image pixels. Omitted images and other non-text input receive markers such as `[image data omitted from summary input]`, without claiming that a model processed the data. The first eight affected messages receive at most two fixed markers each; further omissions receive one aggregate statement. These additions, including newly retained role labels and separators, total at most 847 UTF-8 bytes per summarizer request and count toward token estimates. Existing text is not capped by this omission budget. Custom compaction providers still receive the original message content.

<Note>
New configs default `agents.defaults.compaction.mode` to `"safeguard"` (stricter guardrails, summary quality audits). Set `mode: "default"` explicitly to opt out.
</Note>

With the built-in safeguard quality guard enabled, OpenClaw applies the final
summary budget before validation. Required headings must remain in the retained
generated body, while pending asks and exact identifiers must remain in the
exact text that would be stored. Invalid output gets only the configured number
of corrective attempts. If no finalized summary passes, compaction stops before
writing a transcript entry, keeps the original history, and surfaces the
existing recovery outcome.

## Auto-compaction

Auto-compaction is on by default. It runs when the session nears the context limit, or when the model returns a context-overflow error (in which case OpenClaw compacts and retries).

Stopping a run also stops its overflow or timeout recovery. The built-in OpenClaw runtime does not start further recovery hooks, maintenance, transcript truncation, or retries after cancellation. Cancellation is not rollback: a compaction that already completed remains in the transcript and is still counted, without sending a late reply. The context estimate follows the latest model or compaction observation; billing totals remain separate.

Normal replies check session usage before the next turn. Successful direct commands using the built-in OpenClaw runtime, including `openclaw agent --local`, run the same usage-based maintenance after recording the completed turn and protecting any pending reply. The following command then uses the compacted context. This works in safeguard mode even when memory flush is disabled; native runtimes retain their own compaction ownership.

If direct-command post-turn compaction fails, OpenClaw logs a warning and returns the completed reply while the run and session are still current. Cancellation, restart, or a replaced session still stops that result from being returned.

Set `agents.defaults.compaction.enabled: false` to disable the embedded runtime's proactive threshold compaction and direct-command post-turn maintenance. OpenClaw's preflight and overflow-recovery compaction paths remain available, as does manual `/compact`.

You will see:

- `embedded run auto-compaction start` / `complete` in normal Gateway logs.
- `🧹 Auto-compaction complete` in verbose mode.
- `/status` showing `🧹 Compactions: <count>`.

<Info>
Before compacting, OpenClaw automatically reminds the agent to save important notes to [memory](/concepts/memory) files. This helps preserve durable context.
</Info>

<AccordionGroup>
  <Accordion title="Overflow error patterns OpenClaw recognizes">
    OpenClaw matches dozens of provider-specific overflow error strings (Anthropic, OpenAI, Bedrock, Gemini, Ollama, OpenRouter, and more). Common examples:

    - `request_too_large`
    - `context length exceeded`
    - `input exceeds the maximum number of tokens`
    - `input token count exceeds the maximum number of input tokens` (Bedrock)
    - `input is too long for the model`
    - `ollama error: context length exceeded`

  </Accordion>
</AccordionGroup>

## Manual compaction

Type `/compact` in any chat to force a compaction. Add instructions to guide the summary:

```text
/compact Focus on the API design decisions
```

Client-side compaction in the built-in OpenClaw runtime passes focus to both older-history and split-turn-prefix summaries. The host limits operator-provided focus to 800 Unicode code points and escapes it as prompt data before adding it to model requests.

Client-side manual compaction uses `agents.defaults.compaction.keepRecentTokens` (default: 20,000) as its cut-point budget and keeps that recent tail in rebuilt context.

### Provider checkpoints

When an embedded Responses provider returns a compacted window, OpenClaw preserves the complete returned context alongside the checkpoint. Recent-turn history limits do not discard an eligible checkpoint, and the retained context still counts toward the model's prompt budget. The saved checkpoint is limited to 16 MiB; oversized or incompatible endpoint output uses the normal client-side compaction path instead of being truncated.

If an older version or transcript redaction removes the complete window needed for replay, OpenClaw asks you to run `/compact`. That command rebuilds context from the saved conversation through client-side compaction. It does not guess the missing provider context or delete the transcript.

## Configuration

Configure compaction under `agents.defaults.compaction` in your `openclaw.json`. The most common knobs are listed below; for the full reference, see [Session management deep dive](/reference/session-management-compaction).

### Using a different model

The built-in OpenClaw runtime starts compaction with the active session model. Set `agents.defaults.compaction.model` to select a different summarization model. The override accepts a `provider/model-id` string or a bare alias configured under `agents.defaults.models`:

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

Bare configured aliases resolve to their canonical provider and model before compaction starts. If a bare value matches both an alias and a configured literal model ID, the literal model ID wins. An unmatched bare value remains a model ID on the active provider.

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

In safeguard mode, provider timeouts and rate limits from built-in summarization remain eligible for that chain. Caller cancellation and failed safeguard quality checks do not trigger a model switch.

### Identifier preservation

Compaction summarization preserves opaque identifiers by default (`identifierPolicy: "strict"`). Override with `identifierPolicy: "off"` to disable. Custom guidance belongs in a compaction provider's `summarize()` implementation.

### Active transcript byte guard

When `agents.defaults.compaction.maxActiveTranscriptBytes` is set, OpenClaw
triggers normal local compaction before a run if transcript history reaches
that size. This is useful for long-running sessions where provider-side context
management may keep model context healthy while persisted transcript history
keeps growing. Set a positive byte count or size string such as `"20mb"` to opt
in; `0` or an unset value disables the guard. It does not split raw bytes; it
asks the normal compaction pipeline to create a semantic summary. For Codex
app-server sessions, the same threshold caps native rollout transcripts and
oversized native threads restart fresh.

<Warning>
The byte guard applies to the active SQLite transcript history. Legacy JSONL
checkpoint artifacts are not the active compaction target.
</Warning>

### Successor transcripts

A context engine may return an explicit compacted successor session identity within the same agent, session key, and store. OpenClaw publishes the accepted successor before maintenance, hooks, or retries use it, while retaining the current writer's ownership. Cancelling afterward does not roll that completed transition back. The built-in SQLite compactor keeps the current session identity and does not create a second runtime transcript.

A [worker placement](/gateway/cloud-workers) cannot transfer ownership to a different session identity during compaction. Custom engines must keep the current identity while the placement owns the session, or the operator must move the session back to the Gateway before retrying. A rejected transition leaves the original session and worker claim intact.

OpenClaw no longer writes separate `.checkpoint.*.jsonl` copies for new
compactions. Existing legacy checkpoint files can still be used while referenced
and are pruned by normal session cleanup.

### Compaction notices

By default, compaction runs silently. Set `notifyUser` to show brief status messages when compaction starts and completes, and to surface a degraded notice when a pre-compaction memory flush is exhausted but the reply still continues:

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

Memory flush is optional maintenance: a failure, including exhausted retries, does not reset the session or discard conversation history. If compaction is unnecessary or succeeds, OpenClaw continues the reply; with `notifyUser` enabled, exhausted flush retries also produce a degraded notice. If required compaction fails, OpenClaw reports that failure and keeps the conversation intact instead of starting over automatically.

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

The built-in quality audit and its corrective retries apply only to built-in
summarization. Configured provider output keeps the provider's existing
validation semantics.

<Note>
If the provider fails or returns an empty result, OpenClaw falls back through the built-in safeguard summarizer and its configured quality checks. Provider-local timeouts do not bypass those checks; cancellation of the compaction request is still respected.
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
- [Hooks](/automation/hooks#event-types): internal compaction events (`session:compact:before`, `session:compact:after`).
- [Plugin hooks](/plugins/hooks#hook-catalog): typed compaction hooks (`before_compaction`, `after_compaction`).
