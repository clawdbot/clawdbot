---
summary: "Run OpenClaw through llmman (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local llmman server
  - You are serving Gemma or another model through llmman
  - You need the exact OpenClaw compat flags for llmman
title: "llmman"
---

[llmman](https://github.com/llmmanorg/llmman) pulls GGUF/safetensors models from OCI registries and serves them behind Ollama-, OpenAI-, and Anthropic-compatible APIs. It uses `llama-server` for GGUF models and `vllm` or `mlx_lm.server` for safetensors models. OpenClaw talks to it through the generic `openai-completions` adapter.

| Property         | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| Provider id      | `llmman` (custom; configure under `models.providers.llmman`) |
| Plugin           | none — not a bundled OpenClaw provider plugin                |
| Auth env var     | none required; any value works, `llmman serve` has no auth   |
| API              | OpenAI-compatible (`openai-completions`)                     |
| Default base URL | `http://127.0.0.1:17434/v1`                                  |

<Note>
  `llmman` is a custom self-hosted OpenAI-compatible backend, not a dedicated OpenClaw provider plugin: you configure it under `models.providers.llmman` instead of picking an onboarding auth choice. For a bundled plugin with auto-discovery, see [SGLang](/providers/sglang) or [vLLM](/providers/vllm).
</Note>

<Info>
  Version scope: this page is verified against [llmman b315](https://github.com/llmmanorg/llmman/releases/tag/b315), commit [`0e7a3ed`](https://github.com/llmmanorg/llmman/commit/0e7a3ed815d49a74d7aad1b1c70b5eb6c3013b18).
</Info>

## Getting started

<Steps>
  <Step title="Start llmman with a model">
    ```bash
    LLMMAN_CONTEXT_LENGTH=65536 llmman serve gemma4
    ```

    `llmman serve` listens on `127.0.0.1:17434` by default. Set `LLMMAN_HOST` before startup to override the bind address; there are no `--host`/`--port` flags. GPU acceleration (CUDA, ROCm, Vulkan, or Metal) is auto-detected; set `LLMMAN_LLM_LIBRARY` to override it because there is no `--device` flag. The model argument is optional — omit it to start the server and load models on the first request that names them instead.

    The example fixes the server context at 65,536 tokens and uses the same value in OpenClaw below. If you change `LLMMAN_CONTEXT_LENGTH`, keep the OpenClaw model's `contextWindow` at or below that value.

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
            contextWindow: 65536,
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
          env: { LLMMAN_CONTEXT_LENGTH: "65536" },
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
            contextWindow: 65536,
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
    `llmman` resolves and loads the requested model, rewrites its id for the selected backend, and adds generation defaults such as `repeat_penalty`. It forwards message content and tool schemas without normalizing them, so compatibility for those fields depends on the selected backend and model.

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
    `llmman serve` is not running or is not reachable at the configured address. The default is `127.0.0.1:17434`; if you set `LLMMAN_HOST`, update the OpenClaw `baseUrl` and `healthUrl` to match.
  </Accordion>

  <Accordion title="messages[].content expected a string">
    Set `compat.requiresStringContent: true` in the model entry (see above).
  </Accordion>

  <Accordion title="Direct /v1/chat/completions calls pass but openclaw infer model run fails">
    Both probes are tool-free, so `compat.supportsTools` cannot change this failure. Check the configured base URL and model id, inspect the `llmman`/backend logs, and compare the two request payloads and responses.
  </Accordion>

  <Accordion title="Model run passes but a normal agent turn fails">
    The agent turn includes a larger prompt and may include tool schemas. Try `compat.supportsTools: false` to isolate tool-schema pressure (see the tool-schema caveat above).
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
