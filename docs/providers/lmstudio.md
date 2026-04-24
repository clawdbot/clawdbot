---
summary: "Run OpenClaw with LM Studio"
read_when:
  - You want to run OpenClaw with open source models via LM Studio
  - You want to set up and configure LM Studio
title: "LM Studio"
---

LM Studio is a friendly yet powerful app for running open-weight models on your own hardware. It lets you run llama.cpp (GGUF) or MLX models (Apple Silicon). Comes in a GUI package or headless daemon (`llmster`). For product and setup docs, see [lmstudio.ai](https://lmstudio.ai/).

## Quick start

1. Install LM Studio (desktop) or `llmster` (headless), then start the local server:

```bash
curl -fsSL https://lmstudio.ai/install.sh | bash
```

2. Start the server

Make sure you either start the desktop app or run the daemon using the following command:

```bash
lms daemon up
```

```bash
lms server start --port 1234
```

If you are using the app, make sure you have JIT enabled for a smooth experience. Learn more in the [LM Studio JIT and TTL guide](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict).

3. OpenClaw requires an LM Studio token value. Set `LM_API_TOKEN`:

```bash
export LM_API_TOKEN="your-lm-studio-api-token"
```

If LM Studio authentication is disabled, use any non-empty token value:

```bash
export LM_API_TOKEN="placeholder-key"
```

For LM Studio auth setup details, see [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).

4. Run onboarding and choose `LM Studio`:

```bash
openclaw onboard
```

5. In onboarding, use the `Default model` prompt to pick your LM Studio model.

You can also set or change it later:

```bash
openclaw models set lmstudio/qwen/qwen3.5-9b
```

LM Studio model keys follow a `author/model-name` format (e.g. `qwen/qwen3.5-9b`). OpenClaw
model refs prepend the provider name: `lmstudio/qwen/qwen3.5-9b`. You can find the exact key for
a model by running `curl http://localhost:1234/api/v1/models` and looking at the `key` field.

## Non-interactive onboarding

Use non-interactive onboarding when you want to script setup (CI, provisioning, remote bootstrap):

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice lmstudio
```

Or specify base URL or model with API key:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice lmstudio \
  --custom-base-url http://localhost:1234/v1 \
  --lmstudio-api-key "$LM_API_TOKEN" \
  --custom-model-id qwen/qwen3.5-9b
```

`--custom-model-id` takes the model key as returned by LM Studio (e.g. `qwen/qwen3.5-9b`), without
the `lmstudio/` provider prefix.

Non-interactive onboarding requires `--lmstudio-api-key` (or `LM_API_TOKEN` in env).
For unauthenticated LM Studio servers, any non-empty token value works.

`--custom-api-key` remains supported for compatibility, but `--lmstudio-api-key` is preferred for LM Studio.

This writes `models.providers.lmstudio`, sets the default model to
`lmstudio/<custom-model-id>`, and writes the `lmstudio:default` auth profile.

Interactive setup can prompt for an optional preferred load context length and applies it across the discovered LM Studio models it saves into config.

## Configuration

### Streaming usage compatibility

LM Studio is streaming-usage compatible. When it does not emit an OpenAI-shaped
`usage` object, OpenClaw recovers token counts from llama.cpp-style
`timings.prompt_n` / `timings.predicted_n` metadata instead.

Same behavior applies to these OpenAI-compatible local backends:

- vLLM
- SGLang
- llama.cpp
- LocalAI
- Jan
- TabbyAPI
- text-generation-webui

### Explicit configuration

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        apiKey: "${LM_API_TOKEN}",
        api: "openai-completions",
        models: [
          {
            id: "qwen/qwen3-coder-next",
            name: "Qwen 3 Coder Next",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Troubleshooting

### LM Studio not detected

Make sure LM Studio is running and that you set `LM_API_TOKEN` (for unauthenticated servers, any non-empty token value works):

```bash
# Start via desktop app, or headless:
lms server start --port 1234
```

Verify the API is accessible:

```bash
curl http://localhost:1234/api/v1/models
```

### Authentication errors (HTTP 401)

If setup reports HTTP 401, verify your API key:

- Check that `LM_API_TOKEN` matches the key configured in LM Studio.
- For LM Studio auth setup details, see [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).
- If your server does not require authentication, use any non-empty token value for `LM_API_TOKEN`.

### Just-in-time model loading

LM Studio supports just-in-time (JIT) model loading, where models are loaded on first request. Make sure you have this enabled to avoid 'Model not loaded' errors.

## Related

- [Model selection](/concepts/model-providers)
- [Ollama](/providers/ollama)
- [Local models](/gateway/local-models)
