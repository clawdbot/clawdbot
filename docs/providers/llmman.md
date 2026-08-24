---
summary: "Run OpenClaw through llmman (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local llmman server
  - You are serving Gemma or another model through llmman
  - You need the exact OpenClaw compat flags for llmman
title: "llmman"
---

[llmman](https://github.com/llmmanorg/llmman) pulls GGUF/safetensors models from OCI registries and serves them behind Ollama-, OpenAI-, and Anthropic-compatible APIs, spawning a `llama-server` (or `vllm`) subprocess per model on demand. OpenClaw talks to it through the generic `openai-completions` adapter.

| Property         | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Provider id      | `llmman` (custom; configure under `models.providers.llmman`)        |
| Plugin           | none — not a bundled OpenClaw provider plugin                       |
| Auth env var     | none required; any value works, `llmman serve` has no auth          |
| API              | OpenAI-compatible (`openai-completions`)                            |
| Default base URL | `http://127.0.0.1:17434/v1` (fixed; not configurable via CLI flags) |

<Note>
  `llmman` is a custom self-hosted OpenAI-compatible backend, not a dedicated OpenClaw provider plugin: you configure it under `models.providers.llmman` instead of picking an onboarding auth choice. For a bundled plugin with auto-discovery, see [SGLang](/providers/sglang) or [vLLM](/providers/vllm).
</Note>

## Getting started

<Steps>
  <Step title="Start llmman with a model">
    ```bash
    llmman serve gemma4
    ```

    `llmman serve` always listens on `127.0.0.1:17434` (no `--host`/`--port` flags). GPU acceleration (CUDA, ROCm, Vulkan, or Metal) is auto-detected; there is no `--device` flag. The model argument is optional — omit it to start the server and load models on the first request that names them instead.

  </Step>
  <Step title="Verify the server is reachable">
    ```bash
    curl http://127.0.0.1:17434/v1/models
    curl http://127.0.0.1:17434/api/version
    ```

    `llmman serve` has no dedicated `/health` route at the top level; use `/v1/models` or `/api/version` for a readiness probe.

  </Step>
  <Step title="Add an OpenClaw provider entry">
    Add an explicit provider entry and point your default model at it. See the config example below.
  </Step>
</Steps>

## Full config example

Gemma 4 on a local `llmman` server:

```json5
{
  agents: {
    defaults: {
      model: { primary: "llmman/gemma4" },
      models: {
        "llmman/gemma4": {
          alias: "Gemma 4 (llmman)",
        },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "llmman-local",
        api: "openai-completions",
        models: [
          {
            id: "gemma4",
            name: "Gemma 4 (llmman)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

## On-demand startup

OpenClaw can start `llmman` itself only when an `llmman/...` model is selected. Add `localService` to the same provider entry:

```json5
{
  models: {
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "llmman-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        localService: {
          command: "/opt/homebrew/bin/llmman",
          args: ["serve", "gemma4"],
          healthUrl: "http://127.0.0.1:17434/v1/models",
          readyTimeoutMs: 180000,
          idleStopMs: 0,
        },
        models: [
          {
            id: "gemma4",
            name: "Gemma 4 (llmman)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
          },
        ],
      },
    },
  },
}
```

`command` must be an absolute path. Run `which llmman` on the Gateway host and use that path. Full field reference: [Local model services](/gateway/local-model-services).

## Advanced configuration

<AccordionGroup>
  <Accordion title="Why requiresStringContent might matter">
    `llmman`'s `/v1/chat/completions` route is a plain pass-through proxy to the `llama-server` subprocess it spawns for the requested model, so any Chat Completions request-shape quirks come from your `llama-server` build, not from `llmman` itself.

    <Warning>
    If OpenClaw runs fail with:

    ```text
    messages[1].content: invalid type: sequence, expected a string
    ```

    set `compat.requiresStringContent: true` in the model entry. OpenClaw then flattens pure text content parts into plain strings before sending the request.
    </Warning>

  </Accordion>

  <Accordion title="Tool-schema caveat">
    If a model accepts small direct `/v1/chat/completions` requests but fails on full OpenClaw agent-runtime turns, try disabling the tool schema surface first:

    ```json5
    compat: {
      supportsTools: false
    }
    ```

    That reduces prompt pressure on stricter local backends. If tiny direct requests still work but normal OpenClaw agent turns keep crashing inside `llama-server`, treat it as an upstream model/server limitation rather than an OpenClaw transport issue.

  </Accordion>

  <Accordion title="Manual smoke test">
    Test both layers once configured:

    ```bash
    curl http://127.0.0.1:17434/v1/chat/completions \
      -H 'content-type: application/json' \
      -d '{"model":"gemma4","messages":[{"role":"user","content":"What is 2 + 2?"}],"stream":false}'
    ```

    ```bash
    openclaw infer model run \
      --model llmman/gemma4 \
      --prompt "What is 2 + 2? Reply with one short sentence." \
      --json
    ```

    If the first command works but the second fails, see Troubleshooting below.

  </Accordion>

  <Accordion title="Proxy-style behavior">
    Because `llmman` uses the generic `openai-completions` adapter (not `openai-responses`), native-OpenAI-only request shaping never applies: no `service_tier`, no Responses `store`, no prompt-cache hints, and no OpenAI reasoning-compat payload shaping get sent.
  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="curl /v1/models fails">
    `llmman serve` is not running or not reachable at `127.0.0.1:17434`. Confirm the process is started; there is no host/port to misconfigure since the address is fixed.
  </Accordion>

  <Accordion title="messages[].content expected a string">
    Set `compat.requiresStringContent: true` in the model entry (see above).
  </Accordion>

  <Accordion title="Direct /v1/chat/completions calls pass but openclaw infer model run fails">
    Set `compat.supportsTools: false` to disable the tool schema surface (see the tool-schema caveat above).
  </Accordion>

  <Accordion title="llama-server still crashes on larger agent turns">
    If schema errors are gone but the spawned `llama-server` still crashes on larger agent turns, treat it as an upstream `llama.cpp` or model limitation. Reduce prompt pressure or switch backend/model.
  </Accordion>
</AccordionGroup>

<Tip>
For general help, see [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Running OpenClaw against local model servers.
  </Card>
  <Card title="Local model services" href="/gateway/local-model-services" icon="play">
    Starting local model servers on demand for configured providers.
  </Card>
  <Card title="Gateway troubleshooting" href="/gateway/troubleshooting#local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail" icon="wrench">
    Debugging local OpenAI-compatible backends that pass probes but fail agent runs.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
</CardGroup>
