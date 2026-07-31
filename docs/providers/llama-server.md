---
summary: "Connect OpenClaw to an existing llama.cpp llama-server"
read_when:
  - You run llama-server locally or on a private model host
  - You want automatic model, context, and tool-capability discovery
  - You use llama-server router mode
  - You are choosing between llama-server and the in-process llama-cpp plugin
title: "llama-server"
---

`llama-server` is llama.cpp's standalone HTTP server. OpenClaw connects to its OpenAI-compatible chat API and discovers the models that the process exposes.

The `llama-server` provider connects to an existing process. The separate [`llama-cpp` plugin](/plugins/llama-cpp) loads a GGUF model inside the OpenClaw process through `node-llama-cpp`.

| Property         | Value                                 |
| ---------------- | ------------------------------------- |
| Provider ID      | `llama-server`                        |
| API              | `openai-completions`                  |
| Default base URL | `http://127.0.0.1:8080/v1`            |
| Authentication   | Optional `LLAMA_SERVER_API_KEY`       |
| Model discovery  | Model-list and property endpoints     |
| Process owner    | Operator or configured `localService` |

## Quick start

<Steps>
  <Step title="Start llama-server">
    Start an official llama.cpp server with a stable model alias:

    ```bash
    llama-server \
      --model /path/to/model.gguf \
      --alias my-model \
      --host 127.0.0.1 \
      --port 8080
    ```

    Use the context, GPU, slot, batching, and chat-template flags that fit your deployment. OpenClaw does not choose or change them.

  </Step>
  <Step title="Run OpenClaw setup">
    ```bash
    openclaw onboard
    ```

    Choose `llama-server` and accept the default URL, or enter another local or private endpoint. Leave API-key authentication disabled unless the server or its reverse proxy requires it.

  </Step>
  <Step title="Select the discovered model">
    ```bash
    openclaw models list --provider llama-server
    openclaw models set llama-server/my-model
    ```
  </Step>
</Steps>

The provider reads model IDs from the server. A stable `--alias` keeps the OpenClaw model reference independent of the GGUF file path.

## Non-interactive setup

An unauthenticated local server needs only its URL:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-server \
  --custom-base-url http://127.0.0.1:8080/v1
```

You can select one advertised model explicitly:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-server \
  --custom-base-url http://127.0.0.1:8080/v1 \
  --custom-model-id my-model
```

For an authenticated server, set `LLAMA_SERVER_API_KEY` or pass `--llama-server-api-key`. `--custom-api-key` is also accepted for the shared self-hosted setup path.

```bash
export LLAMA_SERVER_API_KEY="your-server-key"

openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-server \
  --custom-base-url https://models.example.com/v1 \
  --custom-model-id my-model
```

OpenClaw stores no fake API key for an unauthenticated server. The provider uses an internal non-secret marker after model discovery so normal auth resolution can proceed.

## Configuration

Setup writes the endpoint and discovered model metadata:

```json5
{
  models: {
    providers: {
      "llama-server": {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        models: [
          {
            id: "my-model",
            name: "my-model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            contextTokens: 32768,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "llama-server/my-model" },
    },
  },
}
```

OpenClaw accepts the server origin or its `/v1` URL and stores the canonical `/v1` form. Explicit model rows override discovered rows with the same ID. This lets an operator supply compatibility values that the server cannot report, including reasoning and context limits.

### Runtime metadata

For a loaded model, the provider reads `/props` and uses the server's active `n_ctx` for `contextWindow` and `contextTokens`. This reflects the current KV-cache allocation instead of the larger training limit stored in GGUF metadata.

The provider also reads llama.cpp's `chat_template_caps`. Tool use is enabled only when the template reports both tool-definition and tool-call support. Unknown capabilities stay disabled. All tools pass through OpenClaw's `llamacpp-gbnf` schema projection before the request reaches the server.

Reasoning remains disabled unless you set it explicitly on the model row. llama-server reports reasoning output format but does not provide a stable per-model reasoning-capability field.

## Router mode

Starting `llama-server` without `--model` enables router mode. OpenClaw lists the IDs and states returned by `GET /models`, including loaded, sleeping, loading, downloading, failed, and unloaded models.

Discovery is read-only. OpenClaw never calls `/models/load`, `/models/unload`, or `/models?reload=1`. Property requests include `autoload=false`, so catalog refresh does not load an unloaded model. If llama-server's own autoload setting is enabled, the first inference request can load the selected model.

An unloaded router model has conservative OpenClaw capabilities until the server loads it and a later catalog refresh can read `/props`. You can add an explicit model row when OpenClaw needs known tool or reasoning metadata before that first load.

## Authentication and networking

Bind an unauthenticated server to loopback:

```bash
llama-server --host 127.0.0.1 --port 8080 --model /path/to/model.gguf
```

Use llama-server's API-key option or an authenticated reverse proxy when OpenClaw connects to another host. Protect remote traffic with TLS.

The provider allows requests to its exact configured origin, including loopback and private addresses. Redirects and unrelated private origins remain subject to OpenClaw's SSRF policy. URLs containing embedded credentials are rejected.

## Optional local process startup

OpenClaw normally leaves llama-server lifecycle management to the operator. You can opt into the generic [`localService`](/gateway/local-model-services) process manager when OpenClaw should start one existing binary on demand:

```json5
{
  models: {
    providers: {
      "llama-server": {
        baseUrl: "http://127.0.0.1:8080/v1",
        timeoutSeconds: 300,
        localService: {
          command: "/absolute/path/to/llama-server",
          args: [
            "--model",
            "/absolute/path/to/model.gguf",
            "--alias",
            "my-model",
            "--host",
            "127.0.0.1",
            "--port",
            "8080",
          ],
          healthUrl: "http://127.0.0.1:8080/health",
          readyTimeoutMs: 300000,
          idleStopMs: 0,
        },
        models: [],
      },
    },
  },
}
```

`command` must be an absolute path. OpenClaw does not install, download, compile, or update llama-server.

## Troubleshooting

### Server is unavailable

Check the public health and model endpoints:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

A health response with HTTP 503 means the model is still loading. Increase `localService.readyTimeoutMs` for a managed cold start or wait for the externally managed process to become ready.

### Tools are disabled

Inspect the active model properties:

```bash
curl http://127.0.0.1:8080/props
```

Check `chat_template_caps.supports_tools` and `chat_template_caps.supports_tool_calls`. Start llama-server with Jinja enabled and a tool-capable template for the model. OpenClaw does not guess tool support from the model name.

### Router discovery loaded a model

OpenClaw's property requests include `autoload=false`, and model-list requests do not include `reload=1`. Check other clients and the server's `--models-autoload` setting if an unloaded model starts outside an inference request.

### Authentication fails during inference

Model-list and health endpoints may remain public even when chat inference requires a key. Set `LLAMA_SERVER_API_KEY` to the value configured by llama-server or its reverse proxy, then rerun setup or restart the gateway so the environment change is visible.

## Related

- [llama.cpp in-process plugin](/plugins/llama-cpp)
- [Local model services](/gateway/local-model-services)
- [Model providers](/concepts/model-providers)
- [LM Studio](/providers/lmstudio)
