---
summary: "Trimming old tool results to keep context lean and caching efficient"
title: "Session pruning"
read_when:
  - You want to reduce context growth from tool outputs
  - You want to understand Anthropic prompt cache optimization
---

Session pruning trims **old tool results** from the context before each LLM call. It reduces context bloat from accumulated tool outputs (exec results, file reads, search results) without rewriting normal conversation text.

<Info>
Pruning is in-memory only -- it does not modify the on-disk session transcript. Your full history is always preserved.
</Info>

## Why it matters

Long sessions accumulate tool output that inflates the context window. This increases cost and can force [compaction](/concepts/compaction) sooner than necessary.

Pruning is especially valuable for **Anthropic prompt caching**. After the cache TTL expires, the next request re-caches the full prompt. Pruning reduces the cache-write size, directly lowering cost.

## How it works

Pruning runs in `cache-ttl` mode, gated on both a time check and a context-size check:

1. Wait for the cache TTL to expire (default 5 minutes when set manually; see [Smart defaults](#smart-defaults) for the Anthropic auto-default). Before the TTL elapses, pruning is skipped entirely to preserve prompt-cache reuse for nearby turns.
2. Once the TTL has elapsed, estimate total context size against the model's context window. If the ratio is below `softTrimRatio` (default 0.3), skip pruning and keep the TTL clock running.
3. **Soft-trim** oversized tool results above the ratio: keep the head and tail (default 1500 chars each, capped at 4000 chars combined), insert `...` in between.
4. If the ratio is still at or above `hardClearRatio` (default 0.5) and at least `minPrunableToolChars` (default 50,000) of prunable tool content remains, **hard-clear** those results: replace their content with a placeholder (default `[Old tool result content cleared]`).
5. Reset the TTL clock only when pruning actually changed the context, so follow-up requests reuse the fresh cache.

Two safety rules apply regardless of thresholds: the most recent `keepLastAssistants` assistant turns (default 3) are never pruned, and nothing before the session's first user message is ever pruned (protects bootstrap reads like `SOUL.md`/`USER.md`).

Only `toolResult` messages are eligible; normal conversation text is left alone. Use `agents.defaults.contextPruning.tools.{allow,deny}` to scope which tool names are prunable.

## Legacy image cleanup

OpenClaw also builds a separate idempotent replay view for sessions that persist raw image blocks or prompt-hydration media markers in history.

- It preserves the **3 most recent completed turns** byte-for-byte so prompt cache prefixes for recent follow-ups stay stable. This count includes all completed turns, not just image-bearing ones, so text-only turns consume the window too.
- In the replay view, older already-processed image blocks from `user` or `toolResult` history are replaced with `[image data removed - already processed by model]`.
- Older textual media references such as `[media attached: ...]`, `[Image: source: ...]`, and `media://inbound/...` are replaced with `[media reference removed - already processed by model]`. Current-turn attachment markers stay intact so vision models can still hydrate fresh images.
- The raw session transcript is not rewritten, so history viewers can still render the original message entries and their images.
- This is separate from normal cache-TTL pruning above. It exists to stop repeated image payloads or stale media refs from busting prompt caches on later turns.

## Smart defaults

The bundled Anthropic plugin auto-configures pruning and heartbeat cadence the first time it resolves an Anthropic (or Claude CLI) auth profile, but only for fields you have not already set explicitly:

| Auth mode                                | `contextPruning.mode` | `contextPruning.ttl` | `heartbeat.every` |
| ---------------------------------------- | --------------------- | -------------------- | ----------------- |
| OAuth/token (including Claude CLI reuse) | `cache-ttl`           | `1h`                 | `1h`              |
| API key                                  | `cache-ttl`           | `1h`                 | `30m`             |

If you set `agents.defaults.contextPruning.mode` or `agents.defaults.heartbeat.every` yourself, OpenClaw does not override them. This auto-default only fires for Anthropic-family auth; other providers get pruning `off` unless you configure it.

## Enable or disable

Pruning is off by default for non-Anthropic providers. To enable:

```json5
{
  agents: {
    defaults: {
      contextPruning: { mode: "cache-ttl", ttl: "5m" },
    },
  },
}
```

To disable: set `mode: "off"`.

## Pruning vs compaction

|            | Pruning            | Compaction              |
| ---------- | ------------------ | ----------------------- |
| **What**   | Trims tool results | Summarizes conversation |
| **Saved?** | No (per-request)   | Yes (in transcript)     |
| **Scope**  | Tool results only  | Entire conversation     |

They complement each other -- pruning keeps tool output lean between compaction cycles.

## Further reading

- [Compaction](/concepts/compaction): summarization-based context reduction
- [Gateway Configuration](/gateway/configuration): all pruning config knobs (`contextPruning.*`)

## Related

- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Context engine](/concepts/context-engine)
