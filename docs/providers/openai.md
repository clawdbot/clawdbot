---
summary: "Use OpenAI via API keys or Codex subscription in OpenClaw"
read_when:
  - You want to use OpenAI models in OpenClaw
  - You want Codex subscription auth instead of API keys
  - You need stricter GPT-5 agent execution behavior
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. Codex cloud requires ChatGPT sign-in.
OpenAI explicitly supports subscription OAuth usage in external tools/workflows like OpenClaw.

## Default interaction style

OpenClaw can add a small OpenAI-specific prompt overlay for both `openai/*` and
`openai-codex/*` runs. By default, the overlay keeps the assistant warm,
collaborative, concise, direct, and a little more emotionally expressive
without replacing the base OpenClaw system prompt. The friendly overlay also
permits the occasional emoji when it fits naturally, while keeping overall
output concise.

Config key:

`plugins.entries.openai.config.personality`

Allowed values:

- `"friendly"`: default; enable the OpenAI-specific overlay.
- `"on"`: alias for `"friendly"`.
- `"off"`: disable the overlay and use the base OpenClaw prompt only.

Scope:

- Applies to `openai/*` models.
- Applies to `openai-codex/*` models.
- Does not affect other providers.

This behavior is on by default. Keep `"friendly"` explicitly if you want that
to survive future local config churn:

```json5
{
  plugins: {
    entries: {
      openai: {
        config: {
          personality: "friendly",
        },
      },
    },
  },
}
```

### Disable the OpenAI prompt overlay

If you want the unmodified base OpenClaw prompt, set the overlay to `"off"`:

```json5
{
  plugins: {
    entries: {
      openai: {
        config: {
          personality: "off",
        },
      },
    },
  },
}
```

You can also set it directly with the config CLI:

```bash
openclaw config set plugins.entries.openai.config.personality off
```

OpenClaw normalizes this setting case-insensitively at runtime, so values like
`"Off"` still disable the friendly overlay.

## Option A: OpenAI API key (OpenAI Platform)

**Best for:** direct API access and usage-based billing.
Get your API key from the OpenAI dashboard.

Route summary:

- `openai/gpt-5.4` = direct OpenAI Platform API route
- Requires `OPENAI_API_KEY` (or equivalent OpenAI provider config)
- In OpenClaw, ChatGPT/Codex sign-in is routed through `openai-codex/*`, not `openai/*`

### CLI setup

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### Config snippet

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
}
```

OpenAI's current API model docs list `gpt-5.4` and `gpt-5.4-pro` for direct
OpenAI API usage. OpenClaw forwards both through the `openai/*` Responses path.
OpenClaw intentionally suppresses the stale `openai/gpt-5.3-codex-spark` row,
because direct OpenAI API calls reject it in live traffic.

OpenClaw does **not** expose `openai/gpt-5.3-codex-spark` on the direct OpenAI
API path. `pi-ai` still ships a built-in row for that model, but live OpenAI API
requests currently reject it. Spark is treated as Codex-only in OpenClaw.

## Image generation

The bundled `openai` plugin also registers image generation through the shared
`image_generate` tool.

- Default image model: `openai/gpt-image-1`
- Generate: up to 4 images per request
- Edit mode: enabled, up to 5 reference images
- Supports `size`
- Current OpenAI-specific caveat: OpenClaw does not forward `aspectRatio` or
  `resolution` overrides to the OpenAI Images API today

To use OpenAI as the default image provider:

```json5
{
  agents: {
    defaults: {
      imageGenerationModel: {
        primary: "openai/gpt-image-1",
      },
    },
  },
}
```

See [Image Generation](/tools/image-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Video generation

The bundled `openai` plugin also registers video generation through the shared
`video_generate` tool.

- Default video model: `openai/sora-2`
- Modes: text-to-video, image-to-video, and single-video reference/edit flows
- Current limits: 1 image or 1 video reference input
- Current OpenAI-specific caveat: OpenClaw currently only forwards `size`
  overrides for native OpenAI video generation. Unsupported optional overrides
  such as `aspectRatio`, `resolution`, `audio`, and `watermark` are ignored
  and reported back as a tool warning.

To use OpenAI as the default video provider:

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "openai/sora-2",
      },
    },
  },
}
```

See [Video Generation](/tools/video-generation) for the shared tool
parameters, provider selection, and failover behavior.

## Option B: OpenAI Code (Codex) subscription

**Best for:** using ChatGPT/Codex subscription access instead of an API key.
Codex cloud requires ChatGPT sign-in, while the Codex CLI supports ChatGPT or API key sign-in.

Route summary:

- `openai-codex/gpt-5.4` = ChatGPT/Codex OAuth route
- Uses ChatGPT/Codex sign-in, not a direct OpenAI Platform API key
- Provider-side limits for `openai-codex/*` can differ from the ChatGPT web/app experience

### CLI setup (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### Config snippet (Codex subscription)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
}
```

OpenAI's current Codex docs list `gpt-5.4` as the current Codex model. OpenClaw
maps that to `openai-codex/gpt-5.4` for ChatGPT/Codex OAuth usage.

This route is intentionally separate from `openai/gpt-5.4`. If you want the
direct OpenAI Platform API path, use `openai/*` with an API key. If you want
ChatGPT/Codex sign-in, use `openai-codex/*`.

If onboarding reuses an existing Codex CLI login, those credentials stay
managed by Codex CLI. On expiry, OpenClaw re-reads the external Codex source
first and, when the provider can refresh it, writes the refreshed credential
back to Codex storage instead of taking ownership in a separate OpenClaw-only
copy.

If your Codex account is entitled to Codex Spark, OpenClaw also supports:

- `openai-codex/gpt-5.3-codex-spark`

OpenClaw treats Codex Spark as Codex-only. It does not expose a direct
`openai/gpt-5.3-codex-spark` API-key path.

OpenClaw also preserves `openai-codex/gpt-5.3-codex-spark` when `pi-ai`
discovers it. Treat it as entitlement-dependent and experimental: Codex Spark is
separate from GPT-5.4 `/fast`, and availability depends on the signed-in Codex /
ChatGPT account.

### Codex context window cap

OpenClaw treats the Codex model metadata and the runtime context cap as separate
values.

For `openai-codex/gpt-5.4`:

- native `contextWindow`: `1050000`
- default runtime `contextTokens` cap: `272000`

That keeps model metadata truthful while preserving the smaller default runtime
window that has better latency and quality characteristics in practice.

If you want a different effective cap, set `models.providers.<provider>.models[].contextTokens`:

```json5
{
  models: {
    providers: {
      "openai-codex": {
        models: [
          {
            id: "gpt-5.4",
            contextTokens: 160000,
          },
        ],
      },
    },
  },
}
```

Use `contextWindow` only when you are declaring or overriding native model
metadata. Use `contextTokens` when you want to limit the runtime context budget.

### Transport default

OpenClaw uses `pi-ai` for model streaming. For both `openai/*` and
`openai-codex/*`, default transport is `"auto"` (WebSocket-first, then SSE
fallback).

In `"auto"` mode, OpenClaw also retries one early, retryable WebSocket failure
before it falls back to SSE. Forced `"websocket"` mode still surfaces transport
errors directly instead of hiding them behind fallback.

After a connect or early-turn WebSocket failure in `"auto"` mode, OpenClaw marks
that session's WebSocket path as degraded for about 60 seconds and sends
subsequent turns over SSE during the cool-down instead of thrashing between
transports.

For native OpenAI-family endpoints (`openai/*`, `openai-codex/*`, and Azure
OpenAI Responses), OpenClaw also attaches stable session and turn identity state
to requests so retries, reconnects, and SSE fallback stay aligned to the same
conversation identity. On native OpenAI-family routes this includes stable
session/turn request identity headers plus matching transport metadata.

OpenClaw also normalizes OpenAI usage counters across transport variants before
they reach session/status surfaces. Native OpenAI/Codex Responses traffic may
report usage as either `input_tokens` / `output_tokens` or
`prompt_tokens` / `completion_tokens`; OpenClaw treats those as the same input
and output counters for `/status`, `/usage`, and session logs. When native
WebSocket traffic omits `total_tokens` (or reports `0`), OpenClaw falls back to
the normalized input + output total so session/status displays stay populated.

You can set `agents.defaults.models.<provider/model>.params.transport`:

- `"sse"`: force SSE
- `"websocket"`: force WebSocket
- `"auto"`: try WebSocket, then fall back to SSE

For `openai/*` (Responses API), OpenClaw also enables WebSocket warm-up by
default (`openaiWsWarmup: true`) when WebSocket transport is used.

Related OpenAI docs:

- [Realtime API with WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Streaming API responses (SSE)](https://platform.openai.com/docs/guides/streaming-responses)

```json5
{
  agents: {
    defaults: {
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": {
          params: {
            transport: "auto",
          },
        },
      },
    },
  },
}
```

### OpenAI WebSocket warm-up

OpenAI docs describe warm-up as optional. OpenClaw enables it by default for
`openai/*` to reduce first-turn latency when using WebSocket transport.

### Disable warm-up

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: false,
          },
        },
      },
    },
  },
}
```

### Enable warm-up explicitly

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            openaiWsWarmup: true,
          },
        },
      },
    },
  },
}
```

### OpenAI and Codex priority processing

OpenAI's API exposes priority processing via `service_tier=priority`. In
OpenClaw, set `agents.defaults.models["<provider>/<model>"].params.serviceTier`
to pass that field through on native OpenAI/Codex Responses endpoints.

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

Supported values are `auto`, `default`, `flex`, and `priority`.

OpenClaw forwards `params.serviceTier` to both direct `openai/*` Responses
requests and `openai-codex/*` Codex Responses requests when those models point
at the native OpenAI/Codex endpoints.

Important behavior:

- direct `openai/*` must target `api.openai.com`
- `openai-codex/*` must target `chatgpt.com/backend-api`
- if you route either provider through another base URL or proxy, OpenClaw leaves `service_tier` untouched

### OpenAI fast mode

OpenClaw exposes a shared fast-mode toggle for both `openai/*` and
`openai-codex/*` sessions:

- Chat/UI: `/fast status|on|off`
- Config: `agents.defaults.models["<provider>/<model>"].params.fastMode`

When fast mode is enabled, OpenClaw maps it to OpenAI priority processing:

- direct `openai/*` Responses calls to `api.openai.com` send `service_tier = "priority"`
- `openai-codex/*` Responses calls to `chatgpt.com/backend-api` also send `service_tier = "priority"`
- existing payload `service_tier` values are preserved
- fast mode does not rewrite `reasoning` or `text.verbosity`

For GPT 5.4 specifically, the most common setup is:

- send `/fast on` in a session using `openai/gpt-5.4` or `openai-codex/gpt-5.4`
- or set `agents.defaults.models["openai/gpt-5.4"].params.fastMode = true`
- if you also use Codex OAuth, set `agents.defaults.models["openai-codex/gpt-5.4"].params.fastMode = true` too

Example:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
        "openai-codex/gpt-5.4": {
          params: {
            fastMode: true,
          },
        },
      },
    },
  },
}
```

Session overrides win over config. Clearing the session override in the Sessions UI
returns the session to the configured default.

### Native OpenAI versus OpenAI-compatible routes

OpenClaw treats direct OpenAI, Codex, and Azure OpenAI endpoints differently
from generic OpenAI-compatible `/v1` proxies:

- native `openai/*`, `openai-codex/*`, and Azure OpenAI routes keep
  `reasoning: { effort: "none" }` intact when you explicitly disable reasoning
- native OpenAI-family routes default tool schemas to strict mode
- hidden OpenClaw attribution headers (`originator`, `version`, and
  `User-Agent`) are only attached on verified native OpenAI hosts
  (`api.openai.com`) and native Codex hosts (`chatgpt.com/backend-api`)
- native OpenAI/Codex routes keep OpenAI-only request shaping such as
  `service_tier`, Responses `store`, OpenAI reasoning-compat payloads, and
  prompt-cache hints
- proxy-style OpenAI-compatible routes keep the looser compat behavior and do
  not force strict tool schemas, native-only request shaping, or hidden
  OpenAI/Codex attribution headers

Azure OpenAI stays in the native-routing bucket for transport and compat
behavior, but it does not receive the hidden OpenAI/Codex attribution headers.

This preserves current native OpenAI Responses behavior without forcing older
OpenAI-compatible shims onto third-party `/v1` backends.

### Strict-agentic GPT mode

For `openai/*` and `openai-codex/*` GPT-5-family runs, OpenClaw can use a
stricter embedded Pi execution contract:

```json5
{
  agents: {
    defaults: {
      embeddedPi: {
        executionContract: "strict-agentic",
      },
    },
  },
}
```

With `strict-agentic`, OpenClaw no longer treats a plan-only assistant turn as
successful progress when a concrete tool action is available. It retries the
turn with an act-now steer, auto-enables the structured `update_plan` tool for
substantial work, and surfaces an explicit blocked state if the model keeps
planning without acting.

The mode is scoped to OpenAI and OpenAI Codex GPT-5-family runs. Other providers
and older model families keep the default embedded Pi behavior unless you opt
them into other runtime settings.

### OpenAI Responses server-side compaction

For direct OpenAI Responses models (`openai/*` using `api: "openai-responses"` with
`baseUrl` on `api.openai.com`), OpenClaw now auto-enables OpenAI server-side
compaction payload hints:

- Forces `store: true` (unless model compat sets `supportsStore: false`)
- Injects `context_management: [{ type: "compaction", compact_threshold: ... }]`

By default, `compact_threshold` is `70%` of model `contextWindow` (or `80000`
when unavailable).

### Enable server-side compaction explicitly

Use this when you want to force `context_management` injection on compatible
Responses models (for example Azure OpenAI Responses):

```json5
{
  agents: {
    defaults: {
      models: {
        "azure-openai-responses/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
          },
        },
      },
    },
  },
}
```

### Enable with a custom threshold

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: true,
            responsesCompactThreshold: 120000,
          },
        },
      },
    },
  },
}
```

### Disable server-side compaction

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.4": {
          params: {
            responsesServerCompaction: false,
          },
        },
      },
    },
  },
}
```

`responsesServerCompaction` only controls `context_management` injection.
Direct OpenAI Responses models still force `store: true` unless compat sets
`supportsStore: false`.

## Notes

- Model refs always use `provider/model` (see [/concepts/models](/concepts/models)).
- Auth details + reuse rules are in [/concepts/oauth](/concepts/oauth).
