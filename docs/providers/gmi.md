---
summary: "Use GMI Cloud's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with GMI Cloud models
  - You need the GMI provider id, key, or endpoint
title: "GMI Cloud"
---

GMI Cloud is a hosted inference platform for frontier and open-weight models
behind an OpenAI-compatible API. In OpenClaw it is a bundled model provider,
which means you can select it with the provider id `gmi`, store credentials
through normal model auth, and use model refs like
`gmi/google/gemini-3.1-flash-lite`.

Use GMI when you want one API key for several hosted model families, including
Google, Anthropic, OpenAI, DeepSeek, Moonshot, and Z.AI routes exposed by GMI's
catalog. It is useful as a secondary provider for model fallback, for comparing
hosted routes across vendors, or when GMI has a model available before your
primary provider does.

This provider uses OpenAI-compatible chat semantics. OpenClaw owns the provider
id, auth profile, aliases, model catalog seed, and base URL; GMI owns the live
model availability, billing, rate limits, and any provider-side routing policy.

## Setup

Create an API key in GMI Cloud, then run:

```bash
openclaw onboard --auth-choice gmi-api-key
```

Or set:

```bash
export GMI_API_KEY="<your-gmi-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `gmi`
- Aliases: `gmi-cloud`, `gmicloud`
- Base URL: `https://api.gmi-serving.com/v1`
- Env var: `GMI_API_KEY`
- Default model: `gmi/google/gemini-3.1-flash-lite`

## When to choose GMI

- You want a hosted OpenAI-compatible endpoint rather than a local model server.
- You want to try several commercial and open-weight model families through one
  provider account.
- You want a fallback provider with different upstream routing from OpenRouter,
  DeepInfra, Together, or the direct vendor APIs.
- You need GMI-specific model ids, pricing, or account controls.

Choose the direct vendor provider instead when you need vendor-native features
that GMI does not expose through its OpenAI-compatible route. Choose a local
provider such as Ollama, LM Studio, vLLM, or SGLang when data locality or local
GPU control matters more than hosted convenience.

## Models

The bundled catalog seeds commonly available GMI Cloud route ids, including:

- `gmi/zai-org/GLM-5.1-FP8`
- `gmi/deepseek-ai/DeepSeek-V3.2`
- `gmi/moonshotai/Kimi-K2.5`
- `gmi/google/gemini-3.1-flash-lite`
- `gmi/anthropic/claude-sonnet-4.6`
- `gmi/openai/gpt-5.4`

The catalog is a seed, not a promise that every account can call every model at
all times. Use OpenClaw's model listing command to see what the configured
provider reports in your environment:

```bash
openclaw models list --provider gmi
```

## Troubleshooting

- `401` or `403`: check that `GMI_API_KEY` is set for the process running
  OpenClaw, or re-run onboarding to store the key in the provider auth profile.
- Unknown model errors: confirm the model exists in your GMI account and use the
  full `gmi/<route-id>` ref shown by `openclaw models list --provider gmi`.
- Intermittent provider errors: try a different GMI route or configure GMI as a
  fallback rather than the only primary model provider.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
