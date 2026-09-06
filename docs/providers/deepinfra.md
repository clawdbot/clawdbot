---
summary: "Use DeepInfra's unified API to access the most popular open source and frontier models in OpenClaw"
read_when:
  - You want a single API key for the top open source LLMs
  - You want to run models via DeepInfra's API in OpenClaw
title: "DeepInfra"
---

DeepInfra routes requests to popular open source and frontier models behind a
single OpenAI-compatible endpoint and API key. Most OpenAI SDKs work against
it by switching the base URL.

## Install plugin

```bash
openclaw plugins install @openclaw/deepinfra-provider
openclaw gateway restart
```

## Get an API key

1. Sign in at [deepinfra.com](https://deepinfra.com/)
2. Go to Dashboard / Keys and generate a key, or use the auto-created one

## CLI setup

```bash
openclaw onboard --deepinfra-api-key <key>
```

Or set the environment variable:

```bash
export DEEPINFRA_API_KEY="<your-deepinfra-api-key>" # pragma: allowlist secret
```

## Config snippet

```json5
{
  env: { vars: { DEEPINFRA_API_KEY: "<your-deepinfra-api-key>" } }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "deepinfra/deepseek-ai/DeepSeek-V4-Flash" },
    },
  },
}
```

## Supported surfaces

Chat, image generation, and video generation refresh their model catalogs
live from `https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta`
once `DEEPINFRA_API_KEY` is configured. Live discovery expands the list of
selectable models; the default model per surface stays the static value
below. Other surfaces use static catalogs until they move onto the same
live catalog.

| Surface                  | Default model                                                                  | OpenClaw config/tool                                  |
| ------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Chat / model provider    | `deepseek-ai/DeepSeek-V4-Flash` (live catalog adds more chat models)           | `agents.defaults.model`                               |
| Image generation/editing | `black-forest-labs/FLUX-1-schnell` (live catalog adds more `image-gen` models) | `image_generate`, `agents.defaults.mediaModels.image` |
| Media understanding      | `moonshotai/Kimi-K2.5` for images                                              | inbound image understanding                           |
| Speech-to-text           | `openai/whisper-large-v3-turbo`                                                | inbound audio transcription                           |
| Text-to-speech           | `hexgrad/Kokoro-82M`                                                           | `tts.provider: "deepinfra"`                           |
| Video generation         | `Pixverse/Pixverse-T2V` (live catalog adds more `video-gen` models)            | `video_generate`, `agents.defaults.mediaModels.video` |
| Memory embeddings        | `BAAI/bge-m3`                                                                  | `memory.search.provider: "deepinfra"`                 |

DeepInfra also exposes reranking, classification, object-detection, and other
native model types. OpenClaw has no provider contract for those categories
yet, so this plugin does not register them.

## Available models

OpenClaw discovers DeepInfra models dynamically once a key is configured. Use
`/models deepinfra` or `openclaw models list --provider deepinfra` to see the
current list.

Any model on [deepinfra.com](https://deepinfra.com/) works with the
`deepinfra/` prefix:

```text
deepinfra/deepseek-ai/DeepSeek-V4-Flash
deepinfra/deepseek-ai/DeepSeek-V4-Pro
deepinfra/zai-org/GLM-5.2
deepinfra/stepfun-ai/Step-3.7-Flash
deepinfra/moonshotai/Kimi-K2.7-Code
deepinfra/moonshotai/Kimi-K2.6
deepinfra/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B
deepinfra/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B
...and many more
```

## Price estimates

Chat discovery keeps model membership, order, tags, and limits from DeepInfra's
agent projection. Prices come separately from the anonymous native
[`/models/list`](https://docs.deepinfra.com/api-reference/models/models-list)
catalog. The plugin converts cents per token to USD per million tokens, applies
the advertised numeric discount once, and uses the native cached-input ratio.
Both requests share the existing five-minute live-catalog cache and run
concurrently only for configured chat discovery. Image and video discovery do
not request chat prices.

Schedules qualified by pricing prose, a nonempty pricing table, or a scheduled
discount expiry remain unknown; OpenClaw does not guess context tiers or parse
promotion dates. A declared generic cache-write rate also remains unsupported
because its numeric semantics are not documented. Explicit 5-minute/1-hour
retention and priority/flex rates are separate contracts and are not included in
standard estimates. See DeepInfra's [prompt caching](https://docs.deepinfra.com/chat/prompt-caching)
and [cache retention](https://docs.deepinfra.com/chat/prompt-cache-retention) docs.

Missing or unsupported individual price schedules use the required runtime
zero-cost placeholder, which means unknown, not verified free billing. A failed
metadata or native pricing request marks chat discovery unavailable and retains
the last successful catalog for the same provider configuration and credentials.
A successful empty model response clears discovered chat models even when pricing
is unavailable. Live discovery
does not append bundled models absent from the response. Without credentials,
the bundled catalog remains available without fetching. Explicitly configured
models and costs remain authoritative; onboarding does not pin provider prices.

The plugin's public `buildDeepInfraProvider` API keeps its advisory default:
it retains bundled choices and uses unknown price estimates when discovery fails.
OpenClaw's registered catalog hook explicitly selects `discoveryMode: "strict"`
so failed or empty acquisitions reach the shared publication owner unchanged.

Hosted publication uses the same native parser. It preserves metadata without
cost for unsupported or absent schedules, retains declared zero prices, and
leaves the previous hosted catalog intact if the native feed fails validation.
The existing [hosted catalog refresh and Gateway restart lifecycle](/concepts/models#hosted-catalog-updates)
is unchanged.

## Notes

- Model refs are `deepinfra/<provider>/<model>` (for example `deepinfra/Qwen/Qwen3-Max`).
- Default chat model: `deepinfra/deepseek-ai/DeepSeek-V4-Flash`
- Base URL: `https://api.deepinfra.com/v1/openai`
- Video generation uses the OpenAI-compatible async endpoint `https://api.deepinfra.com/v1/openai/videos` (submit, then poll). A configured `baseUrl` is honored. `openclaw doctor --fix` migrates legacy `nativeBaseUrl` or `/v1/inference` values on `api.deepinfra.com` to `baseUrl` automatically; custom native endpoints are retired with a doctor notice and need a manually configured OpenAI-compatible `baseUrl`. Video generation fails with an actionable error (before sending any request) while `baseUrl` still targets the retired `/v1/inference` surface.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
