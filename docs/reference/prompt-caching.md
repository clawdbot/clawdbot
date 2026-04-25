---
summary: "Prompt caching knobs, merge order, provider behavior, and tuning patterns"
title: "Prompt caching"
read_when:
  - You want to reduce prompt token costs with cache retention
  - You need per-agent cache behavior in multi-agent setups
  - You are tuning heartbeat and cache-ttl pruning together
---

Prompt caching means the model provider can reuse unchanged prompt prefixes (usually system/developer instructions and other stable context) across turns instead of re-processing them every time. OpenClaw normalizes provider usage into `cacheRead` and `cacheWrite` where the upstream API exposes those counters directly.

Status surfaces can also recover cache counters from the most recent transcript
usage log when the live session snapshot is missing them, so `/status` can keep
showing a cache line after partial session metadata loss. Existing nonzero live
cache values still take precedence over transcript fallback values.

Why this matters: lower token cost, faster responses, and more predictable performance for long-running sessions. Without caching, repeated prompts pay the full prompt cost on every turn even when most input did not change.

The sections below cover every cache-related knob that affects prompt reuse and token cost.

Provider references:

- Anthropic prompt caching: [https://platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- OpenAI prompt caching: [https://developers.openai.com/api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- OpenAI API headers and request IDs: [https://developers.openai.com/api/reference/overview](https://developers.openai.com/api/reference/overview)
- Anthropic request IDs and errors: [https://platform.claude.com/docs/en/api/errors](https://platform.claude.com/docs/en/api/errors)

## Primary knobs

### `cacheRetention` (global default, model, and per-agent)

Set cache retention as a global default for all models:

```yaml
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long
```

Override per-model:

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # none | short | long
```

Per-agent override:

```yaml
agents:
  list:
    - id: "alerts"
      params:
        cacheRetention: "none"
```

Config merge order:

1. `agents.defaults.params` (global default — applies to all models)
2. `agents.defaults.models["provider/model"].params` (per-model override)
3. `agents.list[].params` (matching agent id; overrides by key)

### `contextPruning.mode: "cache-ttl"`

Prunes old tool-result context after cache TTL windows so post-idle requests do not re-cache oversized history.

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

See [Session Pruning](/concepts/session-pruning) for full behavior.

### Heartbeat keep-warm

Heartbeat can keep cache windows warm and reduce repeated cache writes after idle gaps.

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

Per-agent heartbeat is supported at `agents.list[].heartbeat`.

## Provider behavior

### Anthropic (direct API)

- `cacheRetention` is supported.
- With Anthropic API-key auth profiles, OpenClaw seeds `cacheRetention: "short"` for Anthropic model refs when unset.
- Anthropic native Messages responses expose both `cache_read_input_tokens` and `cache_creation_input_tokens`, so OpenClaw can show both `cacheRead` and `cacheWrite`.
- For native Anthropic requests, `cacheRetention: "short"` maps to the default 5-minute ephemeral cache, and `cacheRetention: "long"` upgrades to the 1-hour TTL only on direct `api.anthropic.com` hosts.

### OpenAI (direct API)

- Prompt caching is automatic on supported recent models. OpenClaw does not need to inject block-level cache markers.
- OpenClaw uses `prompt_cache_key` to keep cache routing stable across turns and uses `prompt_cache_retention: "24h"` only when `cacheRetention: "long"` is selected on direct OpenAI hosts.
- OpenAI-compatible Completions providers receive `prompt_cache_key` only when their model config explicitly sets `compat.supportsPromptCacheKey: true`; `cacheRetention: "none"` still suppresses it.
- OpenAI responses expose cached prompt tokens via `usage.prompt_tokens_details.cached_tokens` (or `input_tokens_details.cached_tokens` on Responses API events). OpenClaw maps that to `cacheRead`.
- OpenAI does not expose a separate cache-write token counter, so `cacheWrite` stays `0` on OpenAI paths even when the provider is warming a cache.
- OpenAI returns useful tracing and rate-limit headers such as `x-request-id`, `openai-processing-ms`, and `x-ratelimit-*`, but cache-hit accounting should come from the usage payload, not from headers.
- In practice, OpenAI often behaves like an initial-prefix cache rather than Anthropic-style moving full-history reuse. Stable long-prefix text turns can land near a `4864` cached-token plateau in current live probes, while tool-heavy or MCP-style transcripts often plateau near `4608` cached tokens even on exact repeats.

### Anthropic Vertex

- Anthropic models on Vertex AI (`anthropic-vertex/*`) support `cacheRetention` the same way as direct Anthropic.
- `cacheRetention: "long"` maps to the real 1-hour prompt-cache TTL on Vertex AI endpoints.
- Default cache retention for `anthropic-vertex` matches direct Anthropic defaults.
- Vertex requests are routed through boundary-aware cache shaping so cache reuse stays aligned with what providers actually receive.

### Amazon Bedrock

- Anthropic Claude model refs (`amazon-bedrock/*anthropic.claude*`) support explicit `cacheRetention` pass-through.
- Non-Anthropic Bedrock models are forced to `cacheRetention: "none"` at runtime.

### OpenRouter models

For `openrouter/anthropic/*` model refs, OpenClaw injects Anthropic
`cache_control` on system/developer prompt blocks to improve prompt-cache
reuse only when the request is still targeting a verified OpenRouter route
(`openrouter` on its default endpoint, or any provider/base URL that resolves
to `openrouter.ai`).

For `openrouter/deepseek/*`, `openrouter/moonshot*/*`, and `openrouter/zai/*`
model refs, `contextPruning.mode: "cache-ttl"` is allowed because OpenRouter
handles provider-side prompt caching automatically. OpenClaw does not inject
Anthropic `cache_control` markers into those requests.

DeepSeek cache construction is best-effort and can take a few seconds. An
immediate follow-up may still show `cached_tokens: 0`; verify with a repeated
same-prefix request after a short delay and use `usage.prompt_tokens_details.cached_tokens`
as the cache-hit signal.

If you repoint the model at an arbitrary OpenAI-compatible proxy URL, OpenClaw
stops injecting those OpenRouter-specific Anthropic cache markers.

### Other providers

If the provider does not support this cache mode, `cacheRetention` has no effect.

### Google Gemini direct API

- Direct Gemini transport (`api: "google-generative-ai"`) reports cache hits
  through upstream `cachedContentTokenCount`; OpenClaw maps that to `cacheRead`.
- When `cacheRetention` is set on a direct Gemini model, OpenClaw automatically
  creates, reuses, and refreshes `cachedContents` resources for system prompts
  on Google AI Studio runs. This means you no longer need to pre-create a
  cached-content handle manually.
- You can still pass a pre-existing Gemini cached-content handle through as
  `params.cachedContent` (or legacy `params.cached_content`) on the configured
  model.
- This is separate from Anthropic/OpenAI prompt-prefix caching. For Gemini,
  OpenClaw manages a provider-native `cachedContents` resource rather than
  injecting cache markers into the request.

### Gemini CLI JSON usage

- Gemini CLI JSON output can also surface cache hits through `stats.cached`;
  OpenClaw maps that to `cacheRead`.
- If the CLI omits a direct `stats.input` value, OpenClaw derives input tokens
  from `stats.input_tokens - stats.cached`.
- This is usage normalization only. It does not mean OpenClaw is creating
  Anthropic/OpenAI-style prompt-cache markers for Gemini CLI.

## System-prompt cache boundary

OpenClaw splits the system prompt into a **stable prefix** and a **volatile
suffix** separated by an internal cache-prefix boundary. Content above the
boundary (tool definitions, skills metadata, workspace files, and other
relatively static context) is ordered so it stays byte-identical across turns.
Content below the boundary (for example `HEARTBEAT.md`, runtime timestamps, and
other per-turn metadata) is allowed to change without invalidating the cached
prefix.

Key design choices:

- Stable workspace project-context files are ordered before `HEARTBEAT.md` so
  heartbeat churn does not bust the stable prefix.
- The boundary is applied across Anthropic-family, OpenAI-family, Google, and
  CLI transport shaping so all supported providers benefit from the same prefix
  stability.
- Codex Responses and Anthropic Vertex requests are routed through
  boundary-aware cache shaping so cache reuse stays aligned with what providers
  actually receive.
- System-prompt fingerprints are normalized (whitespace, line endings,
  hook-added context, runtime capability ordering) so semantically unchanged
  prompts share KV/cache across turns.

If you see unexpected `cacheWrite` spikes after a config or workspace change,
check whether the change lands above or below the cache boundary. Moving
volatile content below the boundary (or stabilizing it) often resolves the
issue.

## OpenClaw cache-stability guards

OpenClaw also keeps several cache-sensitive payload shapes deterministic before
the request reaches the provider:

- Bundle MCP tool catalogs are sorted deterministically before tool
  registration, so `listTools()` order changes do not churn the tools block and
  bust prompt-cache prefixes.
- Legacy sessions with persisted image blocks keep the **3 most recent
  completed turns** intact; older already-processed image blocks may be
  replaced with a marker so image-heavy follow-ups do not keep re-sending large
  stale payloads.

## Tuning patterns

### Mixed traffic (recommended default)

Keep a long-lived baseline on your main agent, disable caching on bursty notifier agents:

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
  list:
    - id: "research"
      default: true
      heartbeat:
        every: "55m"
    - id: "alerts"
      params:
        cacheRetention: "none"
```

### Cost-first baseline

- Set baseline `cacheRetention: "short"`.
- Enable `contextPruning.mode: "cache-ttl"`.
- Keep heartbeat below your TTL only for agents that benefit from warm caches.

## Cache diagnostics

OpenClaw exposes dedicated cache-trace diagnostics for embedded agent runs.

For normal user-facing diagnostics, `/status` and other usage summaries can use
the latest transcript usage entry as a fallback source for `cacheRead` /
`cacheWrite` when the live session entry does not have those counters.

## Live regression tests

OpenClaw keeps one combined live cache regression gate for repeated prefixes, tool turns, image turns, MCP-style tool transcripts, and an Anthropic no-cache control.

- `src/agents/live-cache-regression.live.test.ts`
- `src/agents/live-cache-regression-baseline.ts`

Run the narrow live gate with:

```sh
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache
```

The baseline file stores the most recent observed live numbers plus the provider-specific regression floors used by the test.
The runner also uses fresh per-run session IDs and prompt namespaces so previous cache state does not pollute the current regression sample.

These tests intentionally do not use identical success criteria across providers.

### Anthropic live expectations

- Expect explicit warmup writes via `cacheWrite`.
- Expect near-full history reuse on repeated turns because Anthropic cache control advances the cache breakpoint through the conversation.
- Current live assertions still use high hit-rate thresholds for stable, tool, and image paths.

### OpenAI live expectations

- Expect `cacheRead` only. `cacheWrite` remains `0`.
- Treat repeated-turn cache reuse as a provider-specific plateau, not as Anthropic-style moving full-history reuse.
- Current live assertions use conservative floor checks derived from observed live behavior on `gpt-5.4-mini`:
  - stable prefix: `cacheRead >= 4608`, hit rate `>= 0.90`
  - tool transcript: `cacheRead >= 4096`, hit rate `>= 0.85`
  - image transcript: `cacheRead >= 3840`, hit rate `>= 0.82`
  - MCP-style transcript: `cacheRead >= 4096`, hit rate `>= 0.85`

Fresh combined live verification on 2026-04-04 landed at:

- stable prefix: `cacheRead=4864`, hit rate `0.966`
- tool transcript: `cacheRead=4608`, hit rate `0.896`
- image transcript: `cacheRead=4864`, hit rate `0.954`
- MCP-style transcript: `cacheRead=4608`, hit rate `0.891`

Recent local wall-clock time for the combined gate was about `88s`.

Why the assertions differ:

- Anthropic exposes explicit cache breakpoints and moving conversation-history reuse.
- OpenAI prompt caching is still exact-prefix sensitive, but the effective reusable prefix in live Responses traffic can plateau earlier than the full prompt.
- Because of that, comparing Anthropic and OpenAI by a single cross-provider percentage threshold creates false regressions.

### `diagnostics.cacheTrace` config

```yaml
diagnostics:
  cacheTrace:
    enabled: true
    filePath: "~/.openclaw/logs/cache-trace.jsonl" # optional
    includeMessages: false # default true
    includePrompt: false # default true
    includeSystem: false # default true
```

Defaults:

- `filePath`: `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl`
- `includeMessages`: `true`
- `includePrompt`: `true`
- `includeSystem`: `true`

### Env toggles (one-off debugging)

- `OPENCLAW_CACHE_TRACE=1` enables cache tracing.
- `OPENCLAW_CACHE_TRACE_FILE=/path/to/cache-trace.jsonl` overrides output path.
- `OPENCLAW_CACHE_TRACE_MESSAGES=0|1` toggles full message payload capture.
- `OPENCLAW_CACHE_TRACE_PROMPT=0|1` toggles prompt text capture.
- `OPENCLAW_CACHE_TRACE_SYSTEM=0|1` toggles system prompt capture.

### What to inspect

- Cache trace events are JSONL and include staged snapshots like `session:loaded`, `prompt:before`, `stream:context`, and `session:after`.
- Per-turn cache token impact is visible in normal usage surfaces via `cacheRead` and `cacheWrite` (for example `/usage full` and session usage summaries).
- For Anthropic, expect both `cacheRead` and `cacheWrite` when caching is active.
- For OpenAI, expect `cacheRead` on cache hits and `cacheWrite` to remain `0`; OpenAI does not publish a separate cache-write token field.
- If you need request tracing, log request IDs and rate-limit headers separately from cache metrics. OpenClaw's current cache-trace output is focused on prompt/session shape and normalized token usage rather than raw provider response headers.

## Quick troubleshooting

- High `cacheWrite` on most turns: check for volatile system-prompt inputs and verify model/provider supports your cache settings.
- High `cacheWrite` on Anthropic: often means the cache breakpoint is landing on content that changes every request.
- Low OpenAI `cacheRead`: verify the stable prefix is at the front, the repeated prefix is at least 1024 tokens, and the same `prompt_cache_key` is reused for turns that should share a cache.
- No effect from `cacheRetention`: confirm model key matches `agents.defaults.models["provider/model"]`.
- Bedrock Nova/Mistral requests with cache settings: expected runtime force to `none`.

Related docs:

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Session pruning](/concepts/session-pruning)
- [Gateway configuration reference](/gateway/configuration-reference)

## Related

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
