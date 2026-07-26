---
summary: "Run OpenClaw with LM Studio"
read_when:
  - You want to run OpenClaw with open source models via LM Studio
  - You want to set up and configure LM Studio
title: "LM Studio"
---

LM Studio runs llama.cpp (GGUF) or MLX models locally, as a GUI app or the headless `llmster`
daemon. For install and product docs, see [lmstudio.ai](https://lmstudio.ai/).

## Quick start

<Steps>
  <Step title="Install and start the server">
    Install LM Studio (desktop) or `llmster` (headless), then start the server:

    ```bash
    lms server start --port 1234
    ```

    Or run the headless daemon:

    ```bash
    lms daemon up
    ```

    If using the desktop app, enable JIT for smooth model loading; see the
    [LM Studio JIT and TTL guide](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict).

  </Step>
  <Step title="Set an API key if auth is enabled">
    ```bash
    export LM_API_TOKEN="your-lm-studio-api-token"
    ```

    If LM Studio authentication is disabled, leave the API key blank during setup. See
    [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard
    ```

    Choose `LM Studio`, then pick a model at the `Default model` prompt.

    On a fresh guided setup, OpenClaw first queries `/api/v1/models` on the
    default or configured LM Studio host. An existing LLM is offered automatically
    only when LM Studio reports tool training and at least 16K of effective
    context. For loaded models, the loaded instance context takes precedence over
    the larger advertised maximum. The same CLI/macOS setup ladder verifies the
    route with a real completion before saving it. The automatic check never
    downloads a model and ignores embedding-only catalog entries.

  </Step>
</Steps>

Change the default model later:

```bash
openclaw models set lmstudio/qwen/qwen3.5-9b
```

LM Studio model keys use an `author/model-name` format (e.g. `qwen/qwen3.5-9b`); OpenClaw model refs
prepend the provider: `lmstudio/qwen/qwen3.5-9b`. Find the exact key for a model by running the
command below and looking at the `key` field:

```bash
curl http://localhost:1234/api/v1/models
```

## Non-interactive onboarding

```bash
openclaw onboard --non-interactive --accept-risk --auth-choice lmstudio
```

Or specify base URL, model, and API key explicitly:

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
the `lmstudio/` provider prefix. Pass `--lmstudio-api-key` (or set `LM_API_TOKEN`) for authenticated
servers; omit it for unauthenticated servers and OpenClaw stores a local non-secret marker instead.
`--custom-api-key` is still accepted for compatibility, but `--lmstudio-api-key` is preferred.

This writes `models.providers.lmstudio` and sets the default model to `lmstudio/<custom-model-id>`.
Providing an API key also writes the `lmstudio:default` auth profile.

Interactive setup can additionally prompt for a preferred load context length and applies it across
the discovered models it saves to config.

## Configuration

### Streaming usage compatibility

LM Studio doesn't always emit an OpenAI-shaped `usage` object on streamed responses. OpenClaw
recovers token counts from llama.cpp-style `timings.prompt_n` / `timings.predicted_n` metadata
instead. Any OpenAI-compatible endpoint resolved as a local endpoint (loopback host) gets this same
fallback, which covers other local backends such as vLLM, SGLang, llama.cpp, LocalAI, Jan, TabbyAPI,
and text-generation-webui.

### Thinking compatibility

When LM Studio's `/api/v1/models` discovery reports model-specific reasoning options, OpenClaw
exposes matching `reasoning_effort` values (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) in
model compat metadata. Some LM Studio builds advertise a binary UI option (`allowed_options: ["off",
"on"]`) while rejecting those literal values on `/v1/chat/completions`; OpenClaw normalizes that
binary shape to the six-level scale before sending requests, including for older saved config that
still has `off`/`on` reasoning maps.

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

### Disabling preload

LM Studio supports just-in-time (JIT) model loading, loading models on first request. OpenClaw
preloads models through LM Studio's native load endpoint by default, which helps when JIT is
disabled. To let LM Studio's JIT, idle TTL, and auto-evict behavior own model lifecycle instead,
disable OpenClaw's preload step:

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        params: { preload: false },
        models: [{ id: "qwen/qwen3.5-9b" }],
      },
    },
  },
}
```

### LAN or tailnet host

Use the LM Studio host's reachable address, keep `/v1`, and make sure LM Studio is bound beyond
loopback on that machine:

```json5
{
  models: {
    providers: {
      lmstudio: {
        baseUrl: "http://gpu-box.local:1234/v1",
        apiKey: "lmstudio",
        api: "openai-completions",
        models: [{ id: "qwen/qwen3.5-9b" }],
      },
    },
  },
}
```

`lmstudio` automatically trusts its configured endpoint for model requests, including loopback,
LAN, and tailnet hosts (except metadata/link-local origins). Any custom/local OpenAI-compatible
provider entry gets the same exact-origin trust. Requests to a different private host or port still
require `models.providers.<id>.request.allowPrivateNetwork: true`; set it to `false` to opt out of
the default trust.

## Troubleshooting

### LM Studio not detected

Make sure LM Studio is running:

```bash
lms server start --port 1234
```

If authentication is enabled, also set `LM_API_TOKEN`. Verify the API is reachable:

```bash
curl http://localhost:1234/api/v1/models
```

### Authentication errors (HTTP 401)

- Check that `LM_API_TOKEN` matches the key configured in LM Studio.
- See [LM Studio Authentication](https://lmstudio.ai/docs/developer/core/authentication).
- If the server does not require authentication, leave the key blank during setup.

## Related

- [Model selection](/concepts/model-providers)
- [Ollama](/providers/ollama)
- [Local models](/gateway/local-models)
