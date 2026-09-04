---
summary: "Use NVIDIA's OpenAI-compatible API in OpenClaw"
read_when:
  - You want to use open models in OpenClaw for free
  - You need NVIDIA_API_KEY setup
  - You want to use Nemotron 3 Ultra through NVIDIA
title: "NVIDIA"
---

NVIDIA serves open models for free through an OpenAI-compatible API at
`https://integrate.api.nvidia.com/v1`, authenticated with an API key from
[build.nvidia.com](https://build.nvidia.com/settings/api-keys). OpenClaw
defaults the NVIDIA provider to Nemotron 3 Ultra, NVIDIA's 550B total / 55B
active reasoning model for long-context agentic work.

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [build.nvidia.com](https://build.nvidia.com/settings/api-keys).
  </Step>
  <Step title="Export the key and run onboarding">
    ```bash
    export NVIDIA_API_KEY="nvapi-..."
    openclaw onboard --auth-choice nvidia-api-key
    ```
  </Step>
  <Step title="Set an NVIDIA model">
    ```bash
    openclaw models set nvidia/nvidia/nemotron-3-ultra-550b-a55b
    ```
  </Step>
</Steps>

For non-interactive setup, pass the key directly:

```bash
openclaw onboard --auth-choice nvidia-api-key --nvidia-api-key "nvapi-..."
```

<Warning>
`--nvidia-api-key` lands the key in shell history and `ps` output. Prefer the
`NVIDIA_API_KEY` environment variable when possible.
</Warning>

## Config example

```json5
{
  env: { vars: { NVIDIA_API_KEY: "nvapi-..." } },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/nemotron-3-ultra-550b-a55b" },
    },
  },
}
```

## Live model catalog

When an NVIDIA API key is configured, setup and model-selection paths check
`https://integrate.api.nvidia.com/v1/models` for available model IDs, cached for
30 seconds. NVIDIA's public
`https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json` feed
provides ranking and token limits, cached for 24 hours. Featured models appear
first only while the inference inventory still lists them; other available
bundled chat models follow. A fresh inventory can restore a previously hidden
model that NVIDIA has republished.

The inventory also contains embeddings and other non-chat endpoints, without
capability metadata. OpenClaw therefore offers only exact models with bundled
chat metadata or valid featured-model metadata; it does not guess capabilities
from model names. Unknown IDs can still be configured explicitly; listing alone
does not prove chat compatibility. This is not a complete automatic catalog of
every NVIDIA model.

Both public fetches use fixed HTTPS hosts and send no credentials. If the
featured feed fails, available bundled chat models still appear. If the
inventory is unavailable or malformed, browse and setup retain the bundled
fallback, while the fresh-live catalog stays empty. A successful empty inventory
does not restore stale bundled entries. Without NVIDIA auth, browsing uses the
bundled catalog without fetching.

## Nemotron 3.5 Lightning

[`nvidia/nemotron-3.5-lightning-30b-a3b`](https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/build)
is NVIDIA's smaller 30B total / 3B active reasoning model for agentic work. The
bundled row records its 1M context and a 16,384-token output budget matching
NVIDIA's hosted example. Select it with:

```bash
openclaw models set nvidia/nvidia/nemotron-3.5-lightning-30b-a3b
```

Lightning is selectable when the live inventory lists it even if it is absent
from the featured feed. Nemotron 3 Ultra remains the default.

## Nemotron 3 Ultra

Nemotron 3 Ultra is the default NVIDIA model in OpenClaw. NVIDIA's build page for
[`nvidia/nemotron-3-ultra-550b-a55b`](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b)
lists it as an available free endpoint with a 1M-token context specification.

The bundled Ultra row sends
`chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true }`
by default so normal chat output stays in the visible answer instead of
exposing reasoning text.

Use Ultra for the highest-capability NVIDIA default. Keep Super selected when
you want the smaller Nemotron 3 option, or choose one of the third-party models
hosted in NVIDIA's catalog when their context, latency, or behavior fits better.

## Bundled fallback catalog

The bundled rows provide known chat metadata and an offline fallback. Deprecated
compatibility rows keep existing exact model references recognizable but stay
out of model pickers.

| Model ref                                      | Name                       | Context   | Max output |
| ---------------------------------------------- | -------------------------- | --------- | ---------- |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b`     | Nemotron 3 Ultra 550B      | 1,048,576 | 8,192      |
| `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b` | Nemotron 3.5 Lightning 30B | 1,048,576 | 16,384     |
| `nvidia/nvidia/nemotron-3-super-120b-a12b`     | Nemotron 3 Super 120B      | 1,000,000 | 8,192      |
| `nvidia/z-ai/glm-5.2`                          | GLM 5.2                    | 202,752   | 8,192      |
| `nvidia/moonshotai/kimi-k2.6`                  | Kimi K2.6                  | 262,144   | 65,536     |
| `nvidia/minimaxai/minimax-m3`                  | Minimax M3                 | 196,608   | 8,192      |
| `nvidia/deepseek-ai/deepseek-v4-pro`           | DeepSeek V4 Pro            | 262,144   | 16,384     |

The full compatibility catalog also retains these shipped refs for existing
configurations and migration: `nvidia/qwen/qwen3.5-397b-a17b`,
`nvidia/moonshotai/kimi-k2.5`, `nvidia/z-ai/glm-5.1`, `nvidia/z-ai/glm5`, and
`nvidia/minimaxai/minimax-m2.7`. These references stay hidden from bundled and
offline model pickers unless NVIDIA republishes them in its inference inventory.
NVIDIA has retired the Qwen endpoint, so requests using its model reference no
longer work. Migrate existing Qwen configurations to an active model.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Auto-enable behavior">
    The provider auto-enables when the `NVIDIA_API_KEY` environment variable is
    set or a key was stored during onboarding. No explicit provider config is
    required beyond the key.
  </Accordion>

  <Accordion title="Catalog and pricing">
    OpenClaw uses NVIDIA's inference inventory for availability and its featured
    feed for ranking. Exact bundled metadata preserves reasoning and image
    capabilities omitted by the featured feed. Deprecated exact-reference
    compatibility rows stay hidden from the offline fallback; fresh inventory
    can restore models that NVIDIA has republished. Costs default to `0` in source
    since NVIDIA currently offers free API access for the listed models.
  </Accordion>

  <Accordion title="OpenAI-compatible endpoint">
    OpenClaw talks to NVIDIA with the `openai-completions` adapter against the
    standard `/v1` chat completions route. Any OpenAI-compatible tooling should
    work out of the box with the NVIDIA base URL.
  </Accordion>

  <Accordion title="Nemotron 3 Ultra reasoning params">
    NVIDIA's Ultra sample request uses `chat_template_kwargs.enable_thinking`
    and `reasoning_budget` for reasoning output. OpenClaw's bundled Ultra row
    disables template thinking by default for normal chat use. If you need to
    opt into NVIDIA reasoning output or force other NVIDIA-specific request
    fields, set per-model params and keep provider-specific overrides scoped to
    the NVIDIA model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "nvidia/nvidia/nemotron-3-ultra-550b-a55b": {
              params: {
                chat_template_kwargs: { enable_thinking: true },
                extra_body: { reasoning_budget: 16384 },
              },
            },
          },
        },
      },
    }
    ```

    `params.chat_template_kwargs` merges into any `chat_template_kwargs`
    already on the request instead of replacing the whole object.
    `params.extra_body` is the final OpenAI-compatible request-body override
    and overwrites colliding payload keys, so use it only for fields NVIDIA
    documents for the selected endpoint.

  </Accordion>

  <Accordion title="Slow custom provider responses">
    Some NVIDIA-hosted custom models can take longer than the default ~120s
    model idle watchdog before they emit a first response chunk. For custom
    NVIDIA provider entries, raise the provider timeout instead of the whole
    agent runtime timeout; `timeoutSeconds` covers provider HTTP requests and
    raises the idle/stream watchdog ceiling for that provider:

    ```json5
    {
      models: {
        providers: {
          "custom-integrate-api-nvidia-com": {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            api: "openai-completions",
            apiKey: "NVIDIA_API_KEY",
            timeoutSeconds: 300,
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "custom-integrate-api-nvidia-com/meta/llama-3.1-70b-instruct": {
              params: { thinking: "off" },
            },
          },
        },
      },
    }
    ```

  </Accordion>
</AccordionGroup>

<Tip>
NVIDIA models are currently free to use. Check
[build.nvidia.com](https://build.nvidia.com/) for the latest availability and
rate-limit details.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
