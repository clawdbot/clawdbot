---
summary: "Use GMI Cloud's OpenAI-compatible API with OpenClaw"
read_when:
  - You want to run OpenClaw with GMI Cloud models
  - You need the GMI provider id, key, or endpoint
title: "GMI Cloud"
---

GMI Cloud is a hosted inference platform for frontier and open-weight models
behind an OpenAI-compatible API. In OpenClaw it is an official external provider
plugin: install it once, store credentials through normal model auth, and use
model refs like `gmi/google/gemini-3.1-flash-lite`.

Use GMI when you want one API key for several hosted model families, including
Anthropic, DeepSeek, Google, Moonshot, OpenAI, and Z.AI routes exposed by GMI's
catalog. It works as a secondary provider for model fallback, for comparing
hosted routes across vendors, or when GMI has a model available before your
primary provider does. OpenClaw owns the provider id, auth profile, aliases,
model catalog seed, and base URL; GMI owns live model availability, billing,
rate limits, and any provider-side routing policy.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider id   | `gmi` (aliases: `gmi-cloud`, `gmicloud`) |
| Package       | `@openclaw/gmi-provider`                 |
| Auth env var  | `GMI_API_KEY`                            |
| API           | OpenAI-compatible (`openai-completions`) |
| Base URL      | `https://api.gmi-serving.com/v1`         |
| Default model | `gmi/google/gemini-3.1-flash-lite`       |

## Setup

Install the plugin, restart the gateway, then create an API key in GMI Cloud
(`https://www.gmicloud.ai/`):

```bash
openclaw plugins install @openclaw/gmi-provider
openclaw gateway restart
```

Then run:

```bash
openclaw onboard --auth-choice gmi-api-key
```

Non-interactive setups can pass `--gmi-api-key <key>`, or set:

```bash
export GMI_API_KEY="<your-gmi-api-key>" # pragma: allowlist secret
```

## When to choose GMI

- You want a hosted OpenAI-compatible endpoint rather than a local model server.
- You want to try several commercial and open-weight model families through one
  provider account.
- You want a fallback provider with different upstream routing from DeepInfra,
  OpenRouter, Together, or the direct vendor APIs.
- You need GMI-specific model ids, pricing, or account controls.

Choose the direct vendor provider instead when you need vendor-native features
that GMI does not expose through its OpenAI-compatible route. Choose a local
provider such as LM Studio, Ollama, SGLang, or vLLM when data locality or local
GPU control matters more than hosted convenience.

## Models

The plugin catalog seeds commonly available GMI Cloud route ids:

| Model ref                          | Input        | Context   | Max output |
| ---------------------------------- | ------------ | --------- | ---------- |
| `gmi/anthropic/claude-sonnet-4.6`  | text + image | 200,000   | 64,000     |
| `gmi/deepseek-ai/DeepSeek-V3.2`    | text         | 163,840   | 65,536     |
| `gmi/google/gemini-3.1-flash-lite` | text + image | 1,048,576 | 65,536     |
| `gmi/moonshotai/Kimi-K2.5`         | text + image | 262,144   | 65,536     |
| `gmi/openai/gpt-5.4`               | text + image | 400,000   | 128,000    |
| `gmi/zai-org/GLM-5.1-FP8`          | text         | 202,752   | 65,536     |

The catalog is a seed, not a promise that every account can call every model at
all times. List what the configured provider reports in your environment:

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
