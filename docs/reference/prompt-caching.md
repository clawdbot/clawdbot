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

## Keep model settings stable

Prompt-cache reuse depends on provider request configuration as well as prompt
text. Changing the model always starts a different cache lineage. Changing the
thinking or reasoning level can also invalidate reuse even when the prompt and
model stay the same. Supported native OpenAI Responses requests preserve the
original effort and append turn-scoped configuration controls, including after
transport expiry or a Gateway restart when saved replay metadata and history
still match. See [OpenAI reasoning changes](/providers/openai). Other OpenAI
models or incompatible modes can still reprocess the full prefix. Anthropic
likewise documents cache invalidation when its thinking budget, effort, or mode
changes.

If cache continuity matters, choose the model and thinking level when creating
the session and keep both stable. Start a new session for a planned change.
Invalidating reuse means the next request misses that cached state; it does not
necessarily delete the provider's older cache entry before its normal expiry.

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
3. `agents.entries.*.models["provider/model"].params` - agent-specific per-model override
4. `agents.entries.*.params` - agent-wide override, matched by agent id

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

- When caching is enabled and the route supports tool cache control, the tool prefix is checkpointed separately from the system prompt.
- `cacheRetention` is supported for `anthropic` and `anthropic-vertex` providers, and for Claude models on `amazon-bedrock` and custom `anthropic-messages`-compatible endpoints when `cacheRetention` is set explicitly.
- When unset, OpenClaw seeds `cacheRetention: "short"` for direct Anthropic (`anthropic` and `anthropic-vertex` providers only; other Anthropic-family routes require an explicit value).
- Native Anthropic Messages responses expose `cache_read_input_tokens` and `cache_creation_input_tokens`, mapped to `cacheRead` and `cacheWrite`.
- `cacheRetention: "short"` maps to the default 5-minute ephemeral cache. `cacheRetention: "long"` requests the 1-hour TTL (`cache_control: { type: "ephemeral", ttl: "1h" }`) when set explicitly. An implicit/env-driven long retention (`OPENCLAW_CACHE_RETENTION=long` with no explicit `cacheRetention`) only upgrades to the 1-hour TTL on `api.anthropic.com` or Vertex AI (`aiplatform.googleapis.com` / `*-aiplatform.googleapis.com`) hosts; other hosts keep the 5-minute cache.

Source: `packages/ai/src/transports/anthropic-payload-policy.ts` (`resolveAnthropicEphemeralCacheControl`, `isLongTtlEligibleEndpoint`).

### DeepInfra

For `anthropic/*` models, the managed and SDK Chat Completions paths use the
[shared marker layout](#chat-completions-cache-markers). `cacheRetention: "none"`
disables these markers. By default, both `"short"` and `"long"` use ephemeral markers without
a TTL override; OpenClaw does not assume one-hour support for this route.

### Model Studio / DashScope (Qwen)

Both Chat Completions builders enable the [shared marker layout](#chat-completions-cache-markers)
on native or default Model Studio / DashScope routes through
`compat.cacheControlFormat: "anthropic"`. Explicit model compat settings take
precedence over detected defaults. Custom proxy endpoints receive no automatic
format default; set `compat.cacheControlFormat: "anthropic"` explicitly only when
the proxy supports these markers.

Model Studio includes tool definitions in the system cache and ignores markers on
tools themselves, so OpenClaw omits that marker on detected native routes.
Qwen3.5 and later support message-level checkpoints only: splitting the stable and
volatile system content into blocks does not guarantee independent reuse of the
stable block. See [Model Studio explicit cache guidance](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/explicit-cache-guide).

Explicit `cacheRetention` values reach this transport without enabling
`compat.supportsPromptCacheKey`; leave that flag unset because this route does not
need OpenAI's `prompt_cache_key` or `prompt_cache_retention` fields. With no explicit
retention, the transport keeps its `"short"` default. Model Studio uses a five-minute
explicit cache window, so `"long"` keeps ephemeral markers without requesting a
one-hour TTL.

To disable OpenClaw's explicit markers, set `cacheRetention: "none"`. The current
`compat.cacheControlFormat` schema accepts only `"anthropic"`, not a disable value;
omitting it uses the detected default. Alibaba's automatic implicit caching is
separate and cannot be disabled. Supported models, minimum prompt lengths, and
cache billing are described in [Model Studio context caching](https://www.alibabacloud.com/help/en/model-studio/context-cache).

### OpenAI (direct API)

- Prompt caching is automatic on supported recent models; OpenClaw does not inject block-level cache markers.
- OpenClaw sends `prompt_cache_key` to keep cache routing stable across turns. Responses and Chat Completions requests to direct `api.openai.com` hosts get this automatically when a session or explicit cache key is available; `compat.supportsPromptCacheKey: false` disables it. OpenAI-compatible proxies (oMLX, llama.cpp, custom endpoints) need `compat.supportsPromptCacheKey: true` in model config to opt in - this is never auto-detected for a proxy.
- `cacheRetention: "long"` requests `prompt_cache_options: { ttl: "30m" }` for GPT-5.6 and later on both APIs. Earlier native models receive `prompt_cache_retention: "24h"` only for OpenAI's documented extended-retention models: GPT-5.5 / GPT-5.5 Pro, GPT-5.4, GPT-5.2, GPT-5.1 / Codex / Codex Max / Codex Mini / Chat Latest, GPT-5 / Codex, and GPT-4.1 (including dated snapshots). Other earlier native models receive no lifetime field. See [OpenAI cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime).
- Lifetime fields require both cache-key support and `compat.supportsLongCacheRetention` (true by default; Together AI and Cloudflare profiles disable it). Opted-in proxies use the same GPT-5.6+ TTL mapping and otherwise receive `"24h"`; disable long-retention support if the proxy rejects lifetime fields.
- `cacheRetention: "short"` sends the key without lifetime fields, leaving the provider's default lifetime in effect. `cacheRetention: "none"` suppresses the key and both lifetime fields; it does not disable OpenAI's automatic prompt caching.
- Native ChatGPT-backed Responses routes keep the session cache key, honor `none`, and omit both OpenAI lifetime fields.
- Cache hits surface via `usage.prompt_tokens_details.cached_tokens` (Chat Completions) or `input_tokens_details.cached_tokens` (Responses API), mapped to `cacheRead`.
- Responses API payloads can also expose `input_tokens_details.cache_write_tokens`, mapped to `cacheWrite` and priced at the model's cache-write rate; Responses payloads that omit the field keep `cacheWrite` at `0`. OpenAI's Chat Completions API does not document or emit a `cache_write_tokens` counter, but OpenClaw still reads `prompt_tokens_details.cache_write_tokens` there for OpenRouter-compatible and DeepSeek-style proxies that report a separate write count.
- In practice, OpenAI behaves more like an initial-prefix cache than Anthropic's moving full-history reuse - see [OpenAI live expectations](#openai-live-expectations) below.

### Amazon Bedrock

- Anthropic Claude model refs (`amazon-bedrock/*anthropic.claude*`, plus AWS system inference profile prefixes `us.`/`eu.`/`global.anthropic.claude*`) support explicit `cacheRetention` pass-through.
- The stable system prefix is checkpointed separately from dynamic runtime additions. Conversation checkpoints advance through retained history, including tool results; transient runtime-context carriers remain outside the cached prefix. Bedrock Mantle's Anthropic Messages transport also preserves the separate stable system boundary.
- Nova Micro, Lite, Pro, Premier (`amazon.nova-{micro,lite,pro,premier}-v1:0`), and Nova 2 Lite (`amazon.nova-2-lite-v1:0`) support explicit checkpoints in `system` and `messages`, including their AWS geographic inference profiles and foundation-model ARNs. Both `short` and `long` use Nova's five-minute TTL; `none` disables explicit checkpoints. OpenClaw does not add tool checkpoints for Nova.
- Other non-Claude Bedrock models remain at `cacheRetention: "none"`.
- Nova explicit caching is opt-in: set `cacheRetention` explicitly to `short` or `long`. With retention unset, Nova requests keep their existing payload layout with no checkpoints; neither the default `short` window nor `OPENCLAW_CACHE_RETENTION` enables Nova checkpoints.
- Opaque Bedrock application inference profile ARNs (profile IDs that do not contain `claude`) also resolve to no cache retention unless `cacheRetention` is set explicitly, since the model family cannot be inferred from the ARN alone.

AWS's [prompt caching guide](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
and model cards for [Micro](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html),
[Lite](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html),
[Pro](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-pro.html),
[Premier](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-premier.html),
and [Nova 2 Lite](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html)
list these limits: a 1K-token minimum, four checkpoints, and at most 20K cached
tokens for Nova. Provider token limits still determine whether a checkpoint is cached.

Nova explicit caching has not been live-verified against AWS by OpenClaw maintainers yet.
Live AWS acceptance proof remains a gap until a maintainer with Bedrock access runs it.

### OpenRouter

For `openrouter/anthropic/*` model refs, both Chat Completions builders apply the [shared marker layout](#chat-completions-cache-markers), but only when the request still targets a verified OpenRouter route (`openrouter` on its default endpoint, or any provider/base URL that resolves to `openrouter.ai`). Repointing the model at an arbitrary OpenAI-compatible proxy URL stops automatic marker injection. `cacheRetention: "long"` requests `ttl: "1h"` on these verified routes; `"none"` disables markers. See [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

`contextPruning.mode: "cache-ttl"` is allowed for `openrouter/anthropic/*`, `openrouter/deepseek/*`, `openrouter/moonshot/*`, `openrouter/moonshotai/*`, and `openrouter/zai/*` model refs, because these routes handle provider-side prompt caching without needing OpenClaw's injected markers.

Source: `extensions/openrouter/index.ts` (`OPENROUTER_CACHE_TTL_MODEL_PREFIXES`).

DeepSeek cache construction on OpenRouter is best-effort and can take a few seconds; an immediate follow-up request may still show `cached_tokens: 0`. Verify with a repeated same-prefix request after a short delay, using `usage.prompt_tokens_details.cached_tokens` as the cache-hit signal.

### Google Gemini (direct API)

- Direct Gemini transport (`api: "google-generative-ai"`) reports cache hits through upstream `cachedContentTokenCount`, mapped to `cacheRead`.
- Eligible model families: `gemini-2.5*` and `gemini-3*` (excludes Live/preview variants outside that prefix match, for example `gemini-live-2.5-flash-preview`).
- When `cacheRetention` is set on an eligible model, OpenClaw automatically creates, reuses, and refreshes a `cachedContents` resource containing the stable system prefix above the cache boundary plus tools and tool configuration - no manual cached-content handle needed. TTL is `300s` for `cacheRetention: "short"` and `3600s` for `"long"`.
- The volatile system suffix travels first inside the current turn's hidden runtime-context carrier, before other runtime facts. This carrier is transient, so suffix changes reuse the same resource without accumulating history. Stable-prefix or tool changes create a new resource. If creation fails or the prompt has no cache boundary, the complete system prompt stays inline.
- You can still pass a pre-existing Gemini cached-content handle through as `params.cachedContent` (or legacy `params.cached_content`); an explicit handle skips the automatic cache-management path entirely.
- This is separate from Anthropic/OpenAI prompt-prefix caching: OpenClaw manages a provider-native `cachedContents` resource for Gemini instead of injecting inline cache markers.

Source: `src/agents/embedded-agent-runner/google-prompt-cache.ts`.

### CLI-harness providers (Claude Code, Gemini CLI)

CLI backends that emit JSONL usage events (`jsonlDialect: "claude-stream-json"` or `"gemini-stream-json"`) go through a shared usage parser that recognizes several field-name variants, including a plain `cached` counter mapped to `cacheRead`. When the CLI's JSON payload omits a direct input-token field, OpenClaw derives it as `input_tokens - cached`. This is usage normalization only - it does not create Anthropic/OpenAI-style prompt-cache markers for these CLI-driven models.

Claude Code has no OpenClaw-controlled `cache_control` breakpoint on `--append-system-prompt-file`, so OpenClaw keeps its complete system prompt in that transport. When the bounded version probe on first CLI execution finds Claude Code 2.1.98 or newer, bundled `claude-cli` also passes `--exclude-dynamic-system-prompt-sections`. Concurrent executions share that probe, and API catalog discovery does not start it. That Claude Code flag moves only Claude's own per-machine cwd, environment, memory-path, and Git-status sections out of its native system prompt; an older, unknown, or failed probe keeps the established argv. `cacheRetention` still has no effect on this path.

Source: `src/agents/cli-output.ts` (`toCliUsage`).

### Other providers

If a provider does not support any of the above cache modes, `cacheRetention` has no effect.

## Chat Completions cache markers

OpenAI-compatible routes with `compat.cacheControlFormat: "anthropic"` share one
marker policy across the managed transport, SDK builder, and provider wrappers:

- The last tool definition is marked when the route supports tool markers; tools remain sorted by name.
- The stable system/developer block is marked, with the volatile suffix in a separate unmarked block.
- The latest eligible user text or tool result is marked, advancing through tool loops and new turns while skipping transient runtime-context carriers.

The layout normally uses three markers and stays within the four-breakpoint
budget. `cacheRetention: "none"` emits none. A conversation checkpoint covers
all preceding tools, system content, and messages, so changing the volatile
system suffix still invalidates that later checkpoint; the earlier stable-system
checkpoint remains reusable where the backend supports block-level caching.
Backend token minimums and cache lifetimes still apply.

With `compat.requiresStringContent: true`, managed requests keep message content
as strings and omit message-block markers, including through provider wrappers.
The tool-definition marker remains where supported.

Detected defaults request `ttl: "1h"` only on verified OpenRouter routes. For a
custom endpoint that supports one-hour Anthropic caching, explicitly set
`compat.cacheControlFormat: "anthropic"`, `compat.supportsLongCacheRetention: true`,
and `cacheRetention: "long"` to send that TTL. Omitting the capability override
keeps custom-endpoint markers without a TTL; setting it to `false` disables
the one-hour TTL even on OpenRouter.

## System-prompt cache boundary

OpenClaw splits the system prompt into a **stable prefix** and a **volatile suffix** at an internal cache-prefix boundary. Content above the boundary (tool definitions, skills metadata, workspace files) is ordered to stay byte-identical across turns. Content below the boundary (for example runtime timestamps and other per-turn metadata) can change without invalidating the cached prefix.

Key design choices:

- Stable workspace project-context files are ordered before volatile per-turn metadata so routine churn does not bust the stable prefix.
- The boundary applies across Anthropic-family, OpenAI-family, Google, and CLI transport shaping, so all supported providers benefit from the same prefix stability.
- Codex Responses and Anthropic Vertex requests are routed through boundary-aware cache shaping so cache reuse stays aligned with what providers actually receive.
- System-prompt fingerprints are normalized (whitespace, line endings, hook-added context, runtime capability ordering) so semantically unchanged prompts share cache across turns.

If you see unexpected `cacheWrite` spikes after a config or workspace change, check whether the change lands above or below the cache boundary. Moving volatile content below the boundary (or stabilizing it) usually resolves the issue.

## OpenClaw cache-stability guards

- Active exec sessions, subagent state, and media-generation progress travel in compact Runtime Context carriers after the current user message, so changes do not rewrite the system prompt ahead of conversation history. Project Memory facts, channel-specific ACP hints, delegation/orchestration mode, and the current elevated level stay below the system-prompt cache boundary; static recall, safety, and capability guidance stay above it.
- Delivery instructions live after the system-prompt cache boundary. Native Codex carries the current delivery and target policy in late turn context, so alternating delivery modes does not rebuild its static prompt or message tool catalog when the available capabilities remain unchanged. Actual capability changes still update the catalog.
- Bundled MCP tool catalogs are sorted deterministically (by server name, then tool name) before tool registration, so `listTools()` order changes do not churn the tools block and bust prompt-cache prefixes.
- Message-tool action enums are sorted after policy filtering, keeping identical capabilities stable across channel discovery order changes.
- Native Ollama requests sort tools by name so discovery order changes do not churn the tools prefix.
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
- `src/agents/test-helpers/live-cache-regression-runner.ts`
- `src/agents/live-cache-regression-baseline.ts`

Run it with:

```sh
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache
```

The baseline file stores the most recently observed live numbers plus the provider-specific regression floors the test checks against. Each run uses fresh per-run session IDs and prompt namespaces so previous cache state does not pollute the current sample. Anthropic and OpenAI use different enforcement: an Anthropic floor miss is a hard regression (test fails), while an OpenAI floor miss is watch-only (recorded as a warning, does not fail the run). They do not share a single cross-provider threshold.

Claude CLI prompt reuse has a separate Docker lane because it exercises Claude Code's native session transport rather than the direct Anthropic API. After a fresh turn and tool-bearing warmup resume, it allows a no-tool settlement resume to run hot or cold, dirties the workspace, and requires at least 90% reuse on the following resume without rotating the settled live-session generation. It also verifies that a thinking-level change rotates the generation and that the next steady resume restores at least 90% reuse:

```sh
pnpm test:docker:live-cli-backend:claude:cache
```

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
```

`enabled` defaults to `false`. Cache traces otherwise write to `$OPENCLAW_STATE_DIR/logs/cache-trace.jsonl` and include messages, prompt text, and the system prompt by default. Output-path and payload-inclusion overrides are environment-only controls for one-off debugging.

### Env toggles (one-off debugging)

| Variable                             | Effect                               |
| ------------------------------------ | ------------------------------------ |
| `OPENCLAW_CACHE_TRACE=1`             | Enables cache tracing                |
| `OPENCLAW_CACHE_TRACE_FILE=path`     | Overrides output path                |
| `OPENCLAW_CACHE_TRACE_MESSAGES=0\|1` | Toggles full message payload capture |
| `OPENCLAW_CACHE_TRACE_PROMPT=0\|1`   | Toggles prompt text capture          |
| `OPENCLAW_CACHE_TRACE_SYSTEM=0\|1`   | Toggles system prompt capture        |

### What to inspect

Prompt-cache observations record `input`, `cacheRead`, and `cacheWrite` per completed foreground model request alongside its stable system-prefix/tools fingerprint, and flag cache-read drops from the previous request, including reported zero reads; billing totals remain separate. Observations and warnings require cache tracing (`diagnostics.cacheTrace.enabled` or `OPENCLAW_CACHE_TRACE=1`) or debug logging, and trace results identify each request within its attempt.

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
- **Bedrock Nova requests without cache hits**: set `cacheRetention` explicitly to `short` or `long`, verify that the model is one of the supported variants above, and check that the prefix meets AWS's token limits; `long` still uses a five-minute TTL.

Related docs:

- [Anthropic](/providers/anthropic)
- [Token use and costs](/reference/token-use)
- [Session pruning](/concepts/session-pruning)
- [Gateway configuration reference](/gateway/configuration-reference)

## Related

- [Token use and costs](/reference/token-use)
- [API usage and costs](/reference/api-usage-costs)
