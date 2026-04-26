---
summary: "Trimming old tool results to keep context lean and caching efficient"
title: "Session pruning"
read_when:
  - You want to reduce context growth from tool outputs
  - You want to understand Anthropic prompt cache optimization
---

Session pruning trims **old tool results** from the context before each LLM
call. It reduces context bloat from accumulated tool outputs (exec results, file
reads, search results) without rewriting normal conversation text.

<Info>
Pruning is in-memory only -- it does not modify the on-disk session transcript.
Your full history is always preserved.
</Info>

## Why it matters

Long sessions accumulate tool output that inflates the context window. This
increases cost and can force [compaction](/concepts/compaction) sooner than
necessary.

Pruning is especially valuable for **Anthropic prompt caching**. After the cache
TTL expires, the next request re-caches the full prompt. Pruning reduces the
cache-write size, directly lowering cost.

## How it works

1. Wait for the cache TTL to expire (default 5 minutes).
2. Find old tool results for normal pruning (conversation text is left alone).
3. **Soft-trim** oversized results -- keep the head and tail, insert `...`.
4. **Hard-clear** the rest -- replace with a placeholder.
5. Reset the TTL so follow-up requests reuse the fresh cache.

## Legacy image cleanup

OpenClaw also builds a separate idempotent replay view for sessions that
persist raw image blocks or prompt-hydration media markers in history.

- It preserves the **3 most recent completed turns** byte-for-byte so prompt
  cache prefixes for recent follow-ups stay stable.
- In the replay view, older already-processed image blocks from `user` or
  `toolResult` history can be replaced with
  `[image data removed - already processed by model]`.
- Older textual media references such as `[media attached: ...]`,
  `[Image: source: ...]`, and `media://inbound/...` can be replaced with
  `[media reference removed - already processed by model]`. Current-turn
  attachment markers stay intact so vision models can still hydrate fresh
  images.
- The raw session transcript is not rewritten, so history viewers can still
  render the original message entries and their images.
- This is separate from normal cache-TTL pruning. It exists to stop repeated
  image payloads or stale media refs from busting prompt caches on later turns.

## Smart defaults

OpenClaw auto-enables pruning for Anthropic profiles:

| Profile type                                            | Pruning enabled | Heartbeat |
| ------------------------------------------------------- | --------------- | --------- |
| Anthropic OAuth/token auth (including Claude CLI reuse) | Yes             | 1 hour    |
| API key                                                 | Yes             | 30 min    |

If you set explicit values, OpenClaw does not override them.

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

They complement each other -- pruning keeps tool output lean between
compaction cycles.

## Further reading

- [Compaction](/concepts/compaction) -- summarization-based context reduction
- [Gateway Configuration](/gateway/configuration) -- all pruning config knobs
  (`contextPruning.*`)

## Related

- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Context engine](/concepts/context-engine)
