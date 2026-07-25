---
summary: "Use NovitaAI's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with NovitaAI models
  - You need the Novita provider id, key, or endpoint
title: "NovitaAI"
---

NovitaAI is a hosted AI infrastructure provider with an OpenAI-compatible API.
It ships as a bundled OpenClaw provider (no separate plugin install), so
credentials go through the normal model auth flow and model refs look like
`novita/deepseek/deepseek-v3-0324`.

## Setup

Create an API key at [novita.ai/settings/key-management](https://novita.ai/settings/key-management), then run:

```bash
openclaw onboard --auth-choice novita-api-key
```

Or set:

```bash
export NOVITA_API_KEY="<your-novita-api-key>" # pragma: allowlist secret
```

## Defaults

| Setting       | Value                              |
| ------------- | ---------------------------------- |
| Provider id   | `novita`                           |
| Aliases       | `novita-ai`, `novitaai`            |
| Base URL      | `https://api.novita.ai/openai/v1`  |
| Env var       | `NOVITA_API_KEY`                   |
| Default model | `novita/deepseek/deepseek-v3-0324` |

## Bundled model catalog

- `novita/moonshotai/kimi-k2.5`
- `novita/minimax/minimax-m2.7`
- `novita/zai-org/glm-5`
- `novita/deepseek/deepseek-v3-0324`
- `novita/deepseek/deepseek-r1-0528`
- `novita/qwen/qwen3-235b-a22b-fp8`

This is a starting point, not a live catalog. Your account, region, or
Novita's current offering may add, remove, or restrict routes. Check before
setting a long-lived default:

```bash
openclaw models list --provider novita
```

## When to choose Novita

- Hosted open-weight model access with an OpenAI-compatible API.
- DeepSeek, Kimi, MiniMax, GLM, or Qwen-family routes through a single provider
  account.
- Another hosted fallback path beside DeepInfra, GMI, OpenRouter, or direct
  vendor APIs.
- Provider-side model hosting instead of maintaining LM Studio, Ollama,
  SGLang, or vLLM infrastructure.

Choose a direct vendor provider when you need vendor-native request
parameters or support contracts. Choose a local provider when the model must
run on your own hardware or network boundary.

## Troubleshooting

- `401`/`403`: verify the key in Novita's key management page and re-run
  `openclaw onboard --auth-choice novita-api-key` if the stored profile is
  stale.
- Unknown model errors: use the exact `novita/<route-id>` returned by
  `openclaw models list --provider novita`.
- Slow or failed routes: try another Novita model route, or set Novita as a
  fallback provider for workloads that can tolerate provider-specific
  variance.

## Related

- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
