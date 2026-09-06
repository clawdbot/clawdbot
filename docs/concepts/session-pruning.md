---
summary: "Trimming old tool results to keep context lean and caching efficient"
title: "Session pruning"
read_when:
  - You want to reduce context growth from tool outputs
  - You want to understand Anthropic prompt cache optimization
---

Session pruning trims **old tool results** from the model's context. It reduces context bloat from accumulated tool outputs (exec results, file reads, search results) without rewriting normal conversation text.

<Info>
Your full history is preserved. Client-side pruning keeps a stable projected view
in memory and records it in the hidden `openclaw.cache-ttl` transcript marker so
the same view can be restored after a Gateway restart. Original tool-result
entries are not rewritten.
</Info>

## Why it matters

Long sessions accumulate tool output that inflates the context window. This increases cost and can force [compaction](/concepts/compaction) sooner than necessary.

Pruning is especially valuable for **Anthropic prompt caching**. It reduces the
tool content that must be cached and keeps later requests on the reduced prefix.
Direct Anthropic API-key requests use server-side clearing; other eligible routes
prune locally after the cache TTL expires.

## How it works

Set `agents.defaults.contextPruning.mode` to `"cache-ttl"` to enable pruning.
The request's provider, endpoint, and authentication determine where it runs.

### Direct Anthropic API-key requests

For provider `anthropic` with the `anthropic-messages` API, API-key authentication,
and the default endpoint or `api.anthropic.com`, OpenClaw delegates pruning to
Anthropic's [server-side tool-result clearing](https://platform.claude.com/docs/en/build-with-claude/context-editing).
OpenClaw opens no new client-side pruning rounds, and the server clears old
results before the model sees them. Projections made earlier in the same session
(for example on a proxy route, or restored from the transcript marker) still
replay unchanged. Full local history is retained. `ttl` does
not gate this path.

OpenClaw derives the request parameters without adding config options:

| Parameter           | Value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `trigger`           | Input tokens: `max(50000, floor(contextWindow * 0.3))`                                              |
| `keep`              | The 3 most recent tool uses and their results                                                       |
| `clear_at_least`    | Input tokens: `max(12500, floor(contextWindow * 0.05))`                                             |
| `exclude_tools`     | Current and historical tool names excluded by `tools.deny` or outside `tools.allow` when configured |
| `clear_tool_inputs` | `false`, preserving tool-call arguments                                                             |

The request includes the `clear_tool_uses_20250919` edit and
`context-management-2025-06-27` beta header. If server-side compaction is enabled,
the clearing edit comes before the compaction edit. Explicit caller-provided
`context_management` remains unchanged. Client-side soft-trim and `hardClear`
settings do not change the server's clearing policy.

Clearing invalidates the prompt cache from the first cleared result;
`clear_at_least` prevents a clearing event that would remove too few tokens to
justify the new cache write. When clearing occurs, OpenClaw logs this info line:

```text
[anthropic] server-side context edit: cleared N tool results (M input tokens)
```

### Client-side pruning

Amazon Bedrock, Google, Microsoft Foundry, OAuth, proxies, Vertex, and other
cache-TTL-eligible routes keep client-side pruning. New pruning rounds are gated
on both a time check and a context-size check:

1. Wait for the cache TTL to expire (default 5 minutes when set manually; see [Smart defaults](#smart-defaults) for the Anthropic auto-default). Before the TTL elapses, no new pruning occurs; existing projections still replay unchanged.
2. Once the TTL has elapsed, estimate total context size against the model's context window. Below roughly 30% usage, pruning is skipped and the TTL clock keeps running.
3. **Soft-trim** oversized tool results: results over 4,000 characters keep their first and last 1,500 characters with `...` in between.
4. If context usage is still at or above roughly 50% and at least 50,000 characters of prunable tool content remain, **hard-clear** those results: replace their content with a placeholder (default `[Old tool result content cleared]`, configurable via `agents.defaults.contextPruning.hardClear.placeholder`; set `hardClear.enabled: false` to skip this step).
5. Record each changed result as a session projection and reset the pruning TTL clock. Follow-up requests reuse the same projected bytes, including tool-loop continuations and later turns.

The TTL gates new pruning rounds, not replay of previous projections. Projections
survive Gateway restarts through the transcript marker. Compaction drops
projections for results no longer in the active history; `/new` and session reset
start without the old session's projections. Cache-TTL marker timestamps still
support the existing cache and heartbeat bookkeeping.

Two safety rules apply regardless of thresholds: the last three assistant turns are never pruned, and nothing before the session's first user message is ever pruned (protects bootstrap reads like `SOUL.md`/`USER.md`). The size thresholds and trim windows above are built-in behavior, not config keys; the configurable surface is `agents.defaults.contextPruning` (`mode`, `ttl`, `tools`, `hardClear`).

Only `toolResult` messages are eligible; normal conversation text is left alone. Use `agents.defaults.contextPruning.tools.{allow,deny}` to scope which tool names are prunable on either path.

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

The seeded `ttl` applies to client-side pruning. Direct Anthropic API-key requests
use the token thresholds above while retaining the same heartbeat defaults.

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

To stop new pruning, set `mode: "off"`. Existing client-side projections keep
replaying, including after a Gateway restart, until compaction removes their
results or the session is reset.

## Pruning vs compaction

|            | Pruning                                                              | Compaction                                              |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| **What**   | Trims tool results                                                   | Summarizes conversation                                 |
| **Saved?** | Client projections persist; server clearing keeps full local history | Summary persists in transcript or provider replay state |
| **Scope**  | Tool results only                                                    | Entire conversation                                     |

They complement each other -- pruning keeps tool output lean between compaction cycles.

## Further reading

- [Compaction](/concepts/compaction): summarization-based context reduction
- [Gateway Configuration](/gateway/configuration): all pruning config knobs (`contextPruning.*`)

## Related

- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Context engine](/concepts/context-engine)
