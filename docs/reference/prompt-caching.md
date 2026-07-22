---
summary: "Prompt caching knobs, merge order, provider behavior, and tuning patterns"
title: "Prompt caching"
read_when:
  - You want to reduce prompt token costs with cache retention
  - You need per-agent cache behavior in multi-agent setups
  - You are tuning heartbeat and cache-ttl pruning together
---

Prompt caching lets a model provider reuse an unchanged prompt prefix (system/developer instructions, tool definitions, other stable context) across turns instead of reprocessing it every request. This cuts token cost and latency on long-running sessions with repeated context.

OpenClaw normalizes provider usage into `cacheRead` and `cacheWrite` wherever the upstream API exposes those counters. Usage summaries (`/status` and similar) fall back to the last transcript usage entry when the live session snapshot lacks cache counters; a nonzero live value always wins over the fallback.

Provider references:

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

## Primary knobs

### `cacheRetention`

Values: `"none" | "short" | "long"`. Configurable as a global default, per model, and per agent.
`"standard"` is not an alias; use `"short"` for the provider's default cache window. Invalid values are ignored with a warning.

```yaml
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "short" # overrides the global default for this model
  list:
    - id: "alerts"
      params:
        cacheRetention: "none" # overrides both defaults for this agent
```

Merge order (later wins):

1. `agents.defaults.params` - global default for all models
2. `agents.defaults.models["provider/model"].params` - per-model override
3. `agents.entries.*.params` - per-agent override, matched by agent id

Source: `src/agents/embedded-agent-runner/extra-params.ts` (`resolveExtraParams`).

### `contextPruning.mode: "cache-ttl"`

Prunes old tool-result context after the cache TTL window elapses, so a post-idle request does not re-cache oversized history.

```yaml
agents:
  defaults:
    contextPruning:
      mode: "cache-ttl"
      ttl: "1h"
```

See [Session pruning](/concepts/session-pruning) for full behavior.

### Heartbeat keep-warm

Heartbeat can keep cache windows warm and reduce repeated cache writes after idle gaps. Configurable globally (`agents.defaults.heartbeat`) or per agent (`agents.entries.*.heartbeat`).

```yaml
agents:
  defaults:
    heartbeat:
      every: "55m"
```

## Provider behavior

### Anthropic (direct API and Vertex AI)

- `cacheRetention` is supported for `anthropic` and `anthropic-vertex` providers, and for Claude models on `amazon-bedrock` and custom `anthropic-messages`-compatible endpoints when `cacheRetention` is set explicitly.
- When unset, OpenClaw seeds `cacheRetention: "short"` for direct Anthropic (`anthropic` and `anthropic-vertex` providers only; other Anthropic-family routes require an explicit value).
- Native Anthropic Messages responses expose `cache_read_input_tokens` and `cache_creation_input_tokens`, mapped to `cacheRead` and `cacheWrite`.
- `cacheRetention: "short"` maps to the default 5-minute ephemeral cache. `cacheRetention: "long"` requests the 1-hour TTL (`cache_control: { type: "ephemeral", ttl: "1h" }`) when set explicitly. An implicit/env-driven long retention (`OPENCLAW_CACHE_RETENTION=long` with no explicit `cacheRetention`) only upgrades to the 1-hour TTL on `api.anthropic.com` or Vertex AI (`aiplatform.googleapis.com` / `*-aiplatform.googleapis.com`) hosts; other hosts keep the 5-minute cache.

Source: `packages/ai/src/transports/anthropic-payload-policy.ts` (`resolveAnthropicEphemeralCacheControl`, `isLongTtlEligibleEndpoint`).

### OpenAI (direct API)

- Prompt caching is automatic on supported recent models; OpenClaw does not inject block-level cache markers.
- OpenClaw sends `prompt_cache_key` to keep cache routing stable across turns. Direct `api.openai.com` hosts get this automatically. OpenAI-compatible proxies (oMLX, llama.cpp, custom endpoints) need `compat.supportsPromptCacheKey: true` in model config to opt in - this is never auto-detected for a proxy.
- `prompt_cache_retention: "24h"` is added only when `cacheRetention: "long"` is selected and the resolved endpoint supports both the cache key and long retention (`compat.supportsLongCacheRetention`, true by default; Together AI and Cloudflare compat profiles disable it). `cacheRetention: "none"` suppresses both fields.
- Cache hits surface via `usage.prompt_tokens_details.cached_tokens` (Chat Completions) or `input_tokens_details.cached_tokens` (Responses API), mapped to `cacheRead`.
- Responses API payloads can also expose `input_tokens_details.cache_write_tokens`, mapped to `cacheWrite` and priced at the model's cache-write rate; Responses payloads that omit the field keep `cacheWrite` at `0`. OpenAI's Chat Completions API does not document or emit a `cache_write_tokens` counter, but OpenClaw still reads `prompt_tokens_details.cache_write_tokens` there for OpenRouter-compatible and DeepSeek-style proxies that report a separate write count.
- In practice, OpenAI behaves more like an initial-prefix cache than Anthropic's moving full-history reuse - see [OpenAI live expectations](#openai-live-expectations) below.

### Amazon Bedrock

- Anthropic Claude model refs (`amazon-bedrock/*anthropic.claude*`, plus AWS system inference profile prefixes `us.`/`eu.`/`global.anthropic.claude*`) support explicit `cacheRetention` pass-through.
- Non-Anthropic Bedrock models (for example `amazon.nova-*`) resolve to no cache retention at runtime, regardless of any configured `cacheRetention` value.
- Opaque Bedrock application inference profile ARNs (profile IDs that do not contain `claude`) also resolve to no cache retention unless `cacheRetention` is set explicitly, since the model family cannot be inferred from the ARN alone.

### OpenRouter

For `openrouter/anthropic/*` model refs, OpenClaw injects Anthropic `cache_control` markers on system/developer prompt blocks, but only when the request still targets a verified OpenRouter route (`openrouter` on its default endpoint, or any provider/base URL that resolves to `openrouter.ai`). Repointing the model at an arbitrary OpenAI-compatible proxy URL stops this injection.

`contextPruning.mode: "cache-ttl"` is allowed for `openrouter/anthropic/*`, `openrouter/deepseek/*`, `openrouter/moonshot/*`, `openrouter/moonshotai/*`, and `openrouter/zai/*` model refs, because these routes handle provider-side prompt caching without needing OpenClaw's injected markers.

Source: `extensions/openrouter/index.ts` (`OPENROUTER_CACHE_TTL_MODEL_PREFIXES`).

DeepSeek cache construction on OpenRouter is best-effort and can take a few seconds; an immediate follow-up request may still show `cached_tokens: 0`. Verify with a repeated same-prefix request after a short delay, using `usage.prompt_tokens_details.cached_tokens` as the cache-hit signal.

### Google Gemini (direct API)

- Direct Gemini transport (`api: "google-generative-ai"`) reports cache hits through upstream `cachedContentTokenCount`, mapped to `cacheRead`.
- Eligible model families: `gemini-2.5*` and `gemini-3*` (excludes Live/preview variants outside that prefix match, for example `gemini-live-2.5-flash-preview`).
- When `cacheRetention` is set on an eligible model, OpenClaw automatically creates, reuses, and refreshes a `cachedContents` resource for the system prompt - no manual cached-content handle needed. TTL is `300s` for `cacheRetention: "short"` and `3600s` for `"long"`.
- You can still pass a pre-existing Gemini cached-content handle through as `params.cachedContent` (or legacy `params.cached_content`); an explicit handle skips the automatic cache-management path entirely.
- This is separate from Anthropic/OpenAI prompt-prefix caching: OpenClaw manages a provider-native `cachedContents` resource for Gemini instead of injecting inline cache markers.

Source: `src/agents/embedded-agent-runner/google-prompt-cache.ts`.

### CLI-harness providers (Claude Code, Gemini CLI)

CLI backends that emit JSONL usage events (`jsonlDialect: "claude-stream-json"` or `"gemini-stream-json"`) go through a shared usage parser that recognizes several field-name variants, including a plain `cached` counter mapped to `cacheRead`. When the CLI's JSON payload omits a direct input-token field, OpenClaw derives it as `input_tokens - cached`. This is usage normalization only - it does not create Anthropic/OpenAI-style prompt-cache markers for these CLI-driven models.

Source: `src/agents/cli-output.ts` (`toCliUsage`).

### Other providers

If a provider does not support any of the above cache modes, `cacheRetention` has no effect.

## System-prompt cache boundary

OpenClaw splits the system prompt into a **stable prefix** and a **volatile suffix** at an internal cache-prefix boundary. Content above the boundary (tool definitions, skills metadata, workspace files) is ordered to stay byte-identical across turns. Content below the boundary (for example `HEARTBEAT.md`, runtime timestamps, other per-turn metadata) can change without invalidating the cached prefix.

Key design choices:

- Stable workspace project-context files are ordered before `HEARTBEAT.md` so heartbeat churn does not bust the stable prefix.
- The boundary applies across Anthropic-family, OpenAI-family, Google, and CLI transport shaping, so all supported providers benefit from the same prefix stability.
- Codex Responses and Anthropic Vertex requests are routed through boundary-aware cache shaping so cache reuse stays aligned with what providers actually receive.
- System-prompt fingerprints are normalized (whitespace, line endings, hook-added context, runtime capability ordering) so semantically unchanged prompts share cache across turns.

If you see unexpected `cacheWrite` spikes after a config or workspace change, check whether the change lands above or below the cache boundary. Moving volatile content below the boundary (or stabilizing it) usually resolves the issue.

## OpenClaw cache-stability guards

- Bundled MCP tool catalogs are sorted deterministically (by server name, then tool name) before tool registration, so `listTools()` order changes do not churn the tools block and bust prompt-cache prefixes.
- Legacy sessions with persisted image blocks keep the **3 most recent completed turns** intact (counting all completed turns, not just image-bearing ones). Older already-processed image blocks are replaced with a text marker so image-heavy follow-ups do not keep re-sending large stale payloads.

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

## Live regression tests

OpenClaw runs one combined live cache regression gate covering repeated prefixes, tool turns, image turns, MCP-style tool transcripts, and an Anthropic no-cache control.

- `src/agents/live-cache-regression.live.test.ts`
- `src/agents/live-cache-regression-runner.ts`
- `src/agents/live-cache-regression-baseline.ts`

Run it with:

```sh
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache
```

The baseline file stores the most recently observed live numbers plus the provider-specific regression floors the test checks against. Each run uses fresh per-run session IDs and prompt namespaces so previous cache state does not pollute the current sample. Anthropic and OpenAI use different enforcement: an Anthropic floor miss is a hard regression (test fails), while an OpenAI floor miss is watch-only (recorded as a warning, does not fail the run). They do not share a single cross-provider threshold.

### Anthropic live expectations

- Expect explicit warmup writes via `cacheWrite`.
- Expect near-full history reuse on repeated turns, because Anthropic's cache control advances the cache breakpoint through the conversation.
- Baseline floors for stable, tool, image, and MCP-style lanes are hard regression gates.

### OpenAI live expectations

- Expect `cacheRead` only; `cacheWrite` stays `0` on Chat Completions.
- Treat repeated-turn cache reuse as a provider-specific plateau, not Anthropic-style moving full-history reuse.
- Floors are watch-only (a miss is logged as a warning, not a test failure), derived from observed live behavior on `gpt-5.4-mini`:

| Scenario             | `cacheRead` floor | Hit-rate floor |
| -------------------- | ----------------: | -------------: |
| Stable prefix        |             4,608 |           0.90 |
| Tool transcript      |             4,096 |           0.85 |
| Image transcript     |             3,840 |           0.82 |
| MCP-style transcript |             4,096 |           0.85 |

The most recently observed baseline numbers (from `live-cache-regression-baseline.ts`) landed at: stable prefix `cacheRead=4864`, hit rate `0.966`; tool transcript `cacheRead=4608`, hit rate `0.896`; image transcript `cacheRead=4864`, hit rate `0.954`; MCP-style transcript `cacheRead=4608`, hit rate `0.891`.

Why the assertions differ: Anthropic exposes explicit cache breakpoints and moving conversation-history reuse, while OpenAI's effective reusable prefix in live traffic can plateau earlier than the full prompt. Comparing the two providers against a single cross-provider percentage threshold produces false regressions.

## `diagnostics.cacheTrace` config

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

| Key               | Default                                      |
| ----------------- | -------------------------------------------- |
| `filePath`        | `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl` |
| `includeMessages` | `true`                                       |
| `includePrompt`   | `true`                                       |
| `includeSystem`   | `true`                                       |

### Env toggles (one-off debugging)

| Variable                             | Effect                               |
| ------------------------------------ | ------------------------------------ |
| `OPENCLAW_CACHE_TRACE=1`             | Enables cache tracing                |
| `OPENCLAW_CACHE_TRACE_FILE=path`     | Overrides output path                |
| `OPENCLAW_CACHE_TRACE_MESSAGES=0\|1` | Toggles full message payload capture |
| `OPENCLAW_CACHE_TRACE_PROMPT=0\|1`   | Toggles prompt text capture          |
| `OPENCLAW_CACHE_TRACE_SYSTEM=0\|1`   | Toggles system prompt capture        |

### What to inspect

- Cache trace events are JSONL with staged snapshots like `session:loaded`, `prompt:before`, `stream:context`, and `session:after`.
- Per-turn cache token impact is visible in normal usage surfaces: `cacheRead` and `cacheWrite` show up in `/usage tokens`, `/status`, session usage summaries, and custom `messages.usageTemplate` layouts.
- For Anthropic, expect both `cacheRead` and `cacheWrite` when caching is active.
- For OpenAI, expect `cacheRead` on cache hits; `cacheWrite` is populated only on Responses API payloads that include it (see [OpenAI](#openai-direct-api) above).
- OpenAI also returns tracing and rate-limit headers such as `x-request-id`, `openai-processing-ms`, and `x-ratelimit-*`; use those for request tracing, but cache-hit accounting should still come from the usage payload, not from headers.

## Quick troubleshooting

- **High `cacheWrite` on most turns**: check for volatile system-prompt inputs; verify the model/provider supports your cache settings.
- **High `cacheWrite` on Anthropic**: often means the cache breakpoint is landing on content that changes every request.
- **Low OpenAI `cacheRead`**: verify the stable prefix is at the front, the repeated prefix is at least 1024 tokens, and the same `prompt_cache_key` is reused for turns that should share a cache.
- **No effect from `cacheRetention`**: confirm the model key matches `agents.defaults.models["provider/model"]`.
- **Bedrock Nova requests with cache settings**: expected - these resolve to no cache retention at runtime.

Related docs:

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Session pruning](/concepts/session-pruning)
- [Gateway configuration reference](/gateway/configuration-reference)

## Related

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
