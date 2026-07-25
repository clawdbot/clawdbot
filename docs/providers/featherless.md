---
summary: "Featherless AI setup, model selection, and tool calling"
title: "Featherless AI"
read_when:
  - You want to use Featherless AI with OpenClaw
  - You need the Featherless API key env var or model ref format
---

[Featherless AI](https://featherless.ai) serves open models through an
OpenAI-compatible API. OpenClaw installs Featherless as an official external
provider plugin and keeps the built-in catalog small while accepting exact
model ids from Featherless at runtime.

| Property        | Value                                    |
| --------------- | ---------------------------------------- |
| Provider id     | `featherless`                            |
| Package         | `@openclaw/featherless-provider`         |
| Auth env var    | `FEATHERLESS_API_KEY`                    |
| Onboarding flag | `--auth-choice featherless-api-key`      |
| Direct CLI flag | `--featherless-api-key <key>`            |
| API             | OpenAI-compatible (`openai-completions`) |
| Base URL        | `https://api.featherless.ai/v1`          |
| Default model   | `featherless/Qwen/Qwen3-32B`             |

## Setup

Install the plugin and restart the Gateway:

```bash
openclaw plugins install @openclaw/featherless-provider
openclaw gateway restart
```

Run onboarding:

```bash
openclaw onboard --auth-choice featherless-api-key
```

For non-interactive setup:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice featherless-api-key \
  --featherless-api-key "$FEATHERLESS_API_KEY"
```

Or expose the key to the Gateway process:

```bash
export FEATHERLESS_API_KEY="<your-featherless-api-key>" # pragma: allowlist secret
```

Verify the provider:

```bash
openclaw models list --provider featherless
```

## Default model

The plugin uses `Qwen/Qwen3-32B` as the setup default because Featherless
documents native tool calling for the Qwen 3 family. OpenClaw configures its
32,768-token context window, a conservative 4,096-token output limit, and
Qwen chat-template thinking controls.

The catalog cost fields are zero because Featherless supports multiple billing
modes and OpenClaw does not embed account-specific plan or request-pricing
rates.

## Other Featherless models

Use the exact Featherless model id after the `featherless/` provider prefix:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "featherless/moonshotai/Kimi-K2-Instruct",
      },
    },
  },
}
```

OpenClaw deliberately does not copy Featherless's full public model index into
the picker. The index is large and does not expose enough structured capability
metadata to classify every text, vision, embedding, and reasoning model safely.
Unknown ids therefore resolve with conservative text-only, non-reasoning
defaults: a 4,096-token context window and 1,024-token output limit.

Add an explicit provider model entry when a model needs different metadata:

```json5
{
  models: {
    mode: "merge",
    providers: {
      featherless: {
        baseUrl: "https://api.featherless.ai/v1",
        apiKey: "${FEATHERLESS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "google/gemma-3-27b-it",
            name: "Gemma 3 27B",
            input: ["text", "image"],
            reasoning: false,
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

Check Featherless's model catalog for current model availability and capability
tags before adding custom metadata.

## Troubleshooting

- `401` or `403`: confirm `FEATHERLESS_API_KEY` is visible to the Gateway
  process, or run onboarding again.
- Unknown model: use the exact case-sensitive id from Featherless after the
  `featherless/` prefix.
- Tool calls returned as text: choose a model family Featherless documents for
  native function calling, such as Qwen 3.
- Managed Gateway cannot see the key: put it in `~/.openclaw/.env` or another
  environment source loaded by the service, then restart the Gateway.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
- [Thinking modes](/tools/thinking)
