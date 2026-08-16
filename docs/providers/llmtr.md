---
summary: "Use LLMTR's OpenAI-compatible AI gateway with OpenClaw"
read_when:
  - You want one key covering Anthropic, OpenAI, Google, Qwen, DeepSeek and more
  - You need Turkish data residency or Turkish-language models
  - You need the LLMTR provider id, key, or endpoint
title: "LLMTR"
---

LLMTR is an OpenAI-compatible AI gateway that serves over 230 models behind a
single API key: global passthrough routes across Anthropic, OpenAI, Google,
Qwen, Z.AI, Mistral, DeepSeek, MiniMax, Moonshot, Meta, NVIDIA and others, plus
a Turkey-hosted set for workloads that need Turkish data residency or
Turkish-language models. OpenClaw provides LLMTR through the official external
`@openclaw/llmtr-provider` plugin. Model refs use the
`llmtr/anthropic/claude-sonnet-5` form.

Turkey-hosted routes are named `llmtr/<name>` upstream, so their refs collapse
to a single prefix: the Trendyol model is `llmtr/trendyol-asure-12b`, not
`llmtr/llmtr/trendyol-asure-12b`.

## Setup

Install the plugin and restart the Gateway:

```bash
openclaw plugins install @openclaw/llmtr-provider
openclaw gateway restart
```

Create an API key at [llmtr.com](https://llmtr.com), then run:

```bash
openclaw onboard --auth-choice llmtr-api-key
```

Or set:

```bash
export LLMTR_API_KEY="<your-llmtr-api-key>" # pragma: allowlist secret
```

## Defaults

| Setting       | Value                             |
| ------------- | --------------------------------- |
| Plugin        | `@openclaw/llmtr-provider`        |
| Provider id   | `llmtr`                           |
| Base URL      | `https://llmtr.com/v1`            |
| Env var       | `LLMTR_API_KEY`                   |
| Default model | `llmtr/anthropic/claude-sonnet-5` |

## Model catalog

The plugin refreshes its catalog from `GET /v1/models` and keeps only routes
whose `supported_operations` include `CHAT_COMPLETIONS`, so embedding-only
(`voyageai`, `llmtr/embeddinggemma-300m`), image (`recraft`, `krea`) and
`/v1/responses`-only routes never appear. Context windows, output caps,
modalities, pricing and reasoning support come from the same response. A
snapshot ships with the plugin as the offline fallback.

```bash
openclaw models list --provider llmtr
```

Turkey-hosted:

- `llmtr/gemma-4`
- `llmtr/qwen3-5-4b`
- `llmtr/qwen3-6-35b`
- `llmtr/trendyol-asure-12b`
- `llmtr/muse-glimmer-30b-tr`
- `llmtr/magibu-11b-v8`
- `llmtr/medgemma-4b`

Global passthrough (snapshot selection):

- `llmtr/anthropic/claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.8`,
  `claude-haiku-4.5`
- `llmtr/openai/gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`
- `llmtr/google/gemini-3.7-flash`, `gemini-3.5-flash`,
  `gemini-3.1-pro-preview`
- `llmtr/zai/glm-5.2`, `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.6`,
  `glm-4.6v` (vision)
- `llmtr/qwen/qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-flash`, `qwen3.5-plus`,
  `qwen3-coder-plus`
- `llmtr/deepseek/deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-reasoner`,
  `deepseek-chat`
- `llmtr/moonshot/kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`
- `llmtr/minimax/minimax-m3`, `minimax-m2.7`, `minimax-m2.7-highspeed`,
  `minimax-m2.5`, `minimax-m2.5-highspeed`
- `llmtr/mistral/mistral-large-latest`, `mistral-medium-latest`
- `llmtr/meta/muse-spark-1.2`, `llama-3.3-70b-instruct`
- `llmtr/stepfun/step-3.7-flash`, `llmtr/mimo/mimo-v2.5-pro`,
  `llmtr/kwaikat/kat-coder-pro-v2.5`,
  `llmtr/nvidia/nemotron-3-super-120b-a12b`

## Using a model that is not in the snapshot

Discovery surfaces every chat-capable route the gateway serves, so the snapshot
list above is a floor rather than a limit. To pin a route explicitly — or to
override a published value — add it under `models.providers.llmtr.models`:

```json
{
  "models": {
    "providers": {
      "llmtr": {
        "models": [{ "id": "perplexity/sonar-pro", "contextWindow": 131072, "maxTokens": 32768 }]
      }
    }
  }
}
```

Check `supported_operations` in `curl https://llmtr.com/v1/models` first: models
LLMTR serves solely through `/v1/responses` reject chat-completions requests, as
do embedding, image, video, and audio routes.

## When to choose LLMTR

- One account and key covering Anthropic, OpenAI, Google, Qwen, DeepSeek,
  Z.AI, MiniMax, Moonshot and more, with a shared credit balance.
- Turkish data residency, or Turkish-language models such as Trendyol Asure
  and Muse Glimmer.
- A gateway fallback beside OpenRouter or direct vendor APIs.

Choose a direct vendor provider when you need vendor-native request
parameters, prompt caching, or support contracts — LLMTR adds a platform
margin on credit purchases and normalizes requests through its own gateway.
Some routes also advertise a narrower parameter set than the vendor's own API;
`supported_parameters` in `GET /v1/models` is authoritative, and the plugin
only declares reasoning support for routes that accept a reasoning parameter.

## Troubleshooting

- `401`/`403`: verify the key in the LLMTR dashboard and re-run
  `openclaw onboard --auth-choice llmtr-api-key` if the stored profile is
  stale.
- Errors naming a route that used to work: LLMTR retires routes, and retired
  ids drop out of `GET /v1/models` before they stop answering. `llmtr/sincap`
  and `llmtr/trendyol-7b` are both gone from the catalog;
  `llmtr/trendyol-asure-12b` replaces the latter. Use the ids from
  `openclaw models list --provider llmtr`.
- A model appears on llmtr.com but not in OpenClaw: it is most likely a
  `/v1/responses`-only or non-chat route. Confirm with
  `curl https://llmtr.com/v1/models` and check `supported_operations`.
- `502` or idle timeouts on Turkey-hosted `llmtr/*` routes: these are hosted
  on smaller capacity and can be temporarily unavailable. Retry, or fall back
  to a global route; the same key serves both.

## Related

- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
