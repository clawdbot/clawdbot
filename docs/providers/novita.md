---
summary: "Use NovitaAI's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with NovitaAI models
  - You need the Novita provider id, key, or endpoint
title: "NovitaAI"
---

NovitaAI is a hosted AI infrastructure provider with an OpenAI-compatible model
API. In OpenClaw it is a bundled model provider, so the provider id is
`novita`, credentials go through the normal model auth flow, and model refs look
like `novita/deepseek/deepseek-v3-0324`.

Use Novita when you want hosted access to open-weight and third-party model
routes without running your own inference server. The bundled catalog focuses on
chat models that are practical for agent turns, including DeepSeek, Moonshot,
MiniMax, GLM, and Qwen routes exposed by Novita.

This provider uses Novita's OpenAI-compatible endpoint. OpenClaw handles
provider registration, auth, aliases, model ref normalization, and base URL
selection; Novita controls live model availability, account permissions,
pricing, and rate limits.

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

- Provider: `novita`
- Aliases: `novita-ai`, `novitaai`
- Base URL: `https://api.novita.ai/openai/v1`
- Env var: `NOVITA_API_KEY`
- Default model: `novita/deepseek/deepseek-v3-0324`

## When to choose Novita

- You want hosted open-weight model access with an OpenAI-compatible API.
- You want DeepSeek, Kimi, MiniMax, GLM, or Qwen-family routes through a single
  provider account.
- You want another hosted fallback path beside OpenRouter, GMI, DeepInfra, or
  direct vendor APIs.
- You prefer provider-side model hosting over maintaining vLLM, SGLang, LM
  Studio, or Ollama infrastructure.

Choose a direct vendor provider when you need vendor-native request parameters
or support contracts. Choose a local provider when the model must run on your
own hardware or behind your own network boundary.

## Models

The bundled catalog seeds commonly available NovitaAI route ids, including:

- `novita/moonshotai/kimi-k2.5`
- `novita/minimax/minimax-m2.7`
- `novita/zai-org/glm-5`
- `novita/deepseek/deepseek-v3-0324`
- `novita/deepseek/deepseek-r1-0528`
- `novita/qwen/qwen3-235b-a22b-fp8`

The catalog is a starting point for OpenClaw model selection. Your account,
region, or Novita's current catalog may add, remove, or restrict routes. Check
the provider from the CLI before setting a long-lived default:

```bash
openclaw models list --provider novita
```

## Troubleshooting

- `401` or `403`: verify the key in Novita's key management page and re-run
  `openclaw onboard --auth-choice novita-api-key` if the stored profile is
  stale.
- Unknown model errors: use the exact `novita/<route-id>` returned by
  `openclaw models list --provider novita`.
- Slow or failed routes: try another Novita model route or set Novita as a
  fallback provider for workloads that can tolerate provider-specific variance.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
