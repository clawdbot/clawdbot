---
summary: "Connect OpenClaw to an existing llama.cpp llama-server"
read_when:
  - You already run llama-server locally or on a private model host
  - You want automatic model, context, and tool-capability discovery
  - You use llama-server router mode
  - You are choosing between managed and external llama.cpp setup
sidebarTitle: "llama-server"
title: "llama-server Provider"
---

`llama-server` is llama.cpp's standalone HTTP server. The `llama-server`
provider connects OpenClaw to a process that you already run and manage.
OpenClaw discovers the models and capabilities exposed by the server and sends
chat requests through its OpenAI-compatible API.

The same [`llama-cpp` plugin](/plugins/llama-cpp) also provides the managed
`llama-cpp` provider. The managed provider installs and runs a verified server.
New external setups never install, start, stop, download, or reconfigure
anything. Existing configurations with an explicit `localService` block retain
their previous supervisor behavior for compatibility.

| Property         | Value                             |
| ---------------- | --------------------------------- |
| Provider ID      | `llama-server`                    |
| API              | `openai-completions`              |
| Default base URL | `http://127.0.0.1:8080/v1`        |
| Authentication   | Optional `LLAMA_SERVER_API_KEY`   |
| Model discovery  | Model-list and property endpoints |
| Process owner    | User or external supervisor       |

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

    Choose the context, GPU, slot, batching, and chat-template flags for your
    deployment. OpenClaw does not change them.

  </Step>
  <Step title="Run OpenClaw setup">
    ```bash
    openclaw onboard
    ```

    In the **Local llama.cpp** group, choose **Existing llama-server**. Accept
    the default URL or enter another local or private endpoint. Leave API-key
    authentication disabled unless the server or its reverse proxy requires it.

  </Step>
  <Step title="Select the discovered model">
    ```bash
    openclaw models list --provider llama-server
    openclaw models set llama-server/my-model
    ```
  </Step>
</Steps>

A stable `--alias` keeps the OpenClaw model reference independent of the GGUF
file path.

## Managed and external providers

Install the `llama-cpp` plugin once for either provider:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

| Model reference        | Server owner | Setup behavior                   |
| ---------------------- | ------------ | -------------------------------- |
| `llama-cpp/<model>`    | OpenClaw     | Installs and manages the runtime |
| `llama-server/<model>` | User         | Connects to an existing endpoint |

Both providers can be configured at the same time. Use `llama-cpp` when you
want OpenClaw to manage the process. Use `llama-server` when another terminal,
container, host manager, or machine owns the process.

Existing manual `llama-server` configurations that use `localService` continue
to work. New setups should use the managed `llama-cpp` provider when OpenClaw
must own the server process.

## Discovery

Discovery reads these endpoints:

- `/health`
- `/models`, with `/v1/models` as a compatibility fallback
- `/props` for a single loaded model
- `/props?model=<id>&autoload=false` in router mode

Discovery does not load, wake, unload, download, or reload a model. Router
property requests set `autoload=false`, and model-list requests do not set
`reload=1`.

For each model, OpenClaw uses server metadata for the active context, maximum
output, input types, slot count, build information, status, and chat-template
capabilities. It enables tools only when the server reports both
`supports_tools` and `supports_tool_calls`.

Explicit model entries in `openclaw.json` take priority over discovered rows
with the same model ID.

## Authentication

Set `LLAMA_SERVER_API_KEY` when llama-server or its reverse proxy requires a
bearer token:

```bash
export LLAMA_SERVER_API_KEY="your-key"
openclaw onboard
```

Guided setup can save the key in an OpenClaw auth profile. Provider API keys,
SecretRef values, and explicit authorization headers are also supported. An
explicit authorization header takes priority over bearer-key resolution.

Do not put credentials in the endpoint URL. OpenClaw rejects URLs that contain
a username or password.

## Non-interactive setup

An unauthenticated local server needs its URL:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-server \
  --custom-base-url http://127.0.0.1:8080/v1
```

Select an advertised model explicitly when needed:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-server \
  --custom-base-url http://127.0.0.1:8080/v1 \
  --custom-model-id my-model
```

Pass `--llama-server-api-key` or set `LLAMA_SERVER_API_KEY` for an authenticated
endpoint. When you replace an existing endpoint, pass `--llama-server-api-key`
explicitly. OpenClaw does not reuse the previous endpoint's environment,
profile, header, or configured credentials. Non-interactive setup verifies the
endpoint and selected model before it writes configuration.

## Manual configuration

Guided setup is recommended because it discovers and verifies model metadata.
A minimal manual provider has this shape:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "llama-server": {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [],
      },
    },
  },
}
```

The private-network option is required for loopback and private endpoints.
OpenClaw still pins requests to the configured origin and blocks cloud metadata
and unsafe redirects.

## Troubleshooting

### Server is unavailable

Check the public health and model endpoints:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/models
```

HTTP 503 from `/health` means the model is still loading. Wait for the external
process to become ready. OpenClaw does not restart it.

### Tools are disabled

Inspect the active model properties:

```bash
curl http://127.0.0.1:8080/props
```

Check `chat_template_caps.supports_tools` and
`chat_template_caps.supports_tool_calls`. Start llama-server with Jinja enabled
and a tool-capable template. OpenClaw does not guess tool support from the model
name.

### Router discovery loaded a model

OpenClaw property requests include `autoload=false`, and model-list requests do
not include `reload=1`. Check other clients and the server's
`--models-autoload` setting if a model loads outside an inference request.

### Authentication fails during inference

Health and model-list endpoints can remain public while chat inference requires
a key. Set `LLAMA_SERVER_API_KEY` to the value expected by llama-server or its
reverse proxy, then rerun setup or restart the Gateway so it can read the new
environment value.

### Structured output fails

Use a current official llama.cpp release. OpenClaw maps JSON Schema requests to
llama-server's `json_object` schema shape so structured output also works with
older external server builds.

## Related

- [llama.cpp plugin](/plugins/llama-cpp)
- [Local model services](/gateway/local-model-services)
- [Model providers](/concepts/model-providers)
- [LM Studio](/providers/lmstudio)
