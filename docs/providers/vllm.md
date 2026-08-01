---
summary: "Run OpenClaw with vLLM (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM"
---

vLLM serves open-source (and some custom) models through an **OpenAI-compatible** HTTP API. OpenClaw connects using the `openai-completions` API and can **auto-discover** models when you opt in with `VLLM_API_KEY`.

| Property         | Value                                      |
| ---------------- | ------------------------------------------ |
| Provider ID      | `vllm`                                     |
| API              | `openai-completions` (OpenAI-compatible)   |
| Auth             | `VLLM_API_KEY` environment variable        |
| Default base URL | `http://127.0.0.1:8000/v1`                 |
| Streaming usage  | Supported (`stream_options.include_usage`) |

## Getting started

<Steps>
  <Step title="Start vLLM with an OpenAI-compatible server">
    Your base URL must expose `/v1` endpoints (`/v1/models`, `/v1/chat/completions`). vLLM commonly runs on:

    ```text
    http://127.0.0.1:8000/v1
    ```

  </Step>
  <Step title="Set the API key environment variable">
    Any non-empty value works if your server does not enforce auth:

    ```bash
    export VLLM_API_KEY="vllm-local"
    ```

  </Step>
  <Step title="Select a model">
    Replace with one of your vLLM model IDs:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "vllm/your-model-id" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider vllm
    ```
  </Step>
</Steps>

<Tip>
For non-interactive setup (CI, scripting), pass the base URL, key, and model directly:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice vllm \
  --custom-base-url "http://127.0.0.1:8000/v1" \
  --custom-api-key "vllm-local" \
  --custom-model-id "your-model-id"
```

</Tip>

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and `models.providers.vllm` is **not** defined, OpenClaw queries `GET http://127.0.0.1:8000/v1/models` and converts the returned IDs into model entries.

<Note>
If you set `models.providers.vllm` explicitly, OpenClaw uses only your declared models. Add `"vllm/*": {}` to `agents.defaults.models` to make OpenClaw also query that configured provider's `/models` endpoint and include all advertised vLLM models.
</Note>

## Explicit configuration

Configure explicitly when vLLM runs on a different host or port, you want to pin `contextWindow`/`maxTokens`, your server requires a real API key, or you connect to a trusted loopback, LAN, or Tailscale endpoint:

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        timeoutSeconds: 300, // Optional: extend request timeout for slow local models
        models: [
          {
            id: "your-model-id",
            name: "Local vLLM Model",
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

To keep the provider dynamic without listing every model, add a wildcard to the visible model catalog:

```json5
{
  agents: {
    defaults: {
      models: {
        "vllm/*": {},
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Proxy-style behavior">
    vLLM is treated as a proxy-style OpenAI-compatible `/v1` backend, not a native OpenAI endpoint:

    | Behavior                                | Applied?                         |
    | --------------------------------------- | -------------------------------- |
    | Native OpenAI request shaping           | No                               |
    | `service_tier`                          | Not sent                         |
    | Responses `store`                       | Not sent                         |
    | Prompt-cache hints                      | Not sent                         |
    | OpenAI reasoning-compat payload shaping | Not applied                      |
    | Hidden OpenClaw attribution headers     | Not injected on custom base URLs |

  </Accordion>

  <Accordion title="Qwen thinking controls">
    For Qwen models, set `compat.thinkingFormat: "qwen-chat-template"` on the model row when the server expects Qwen chat-template kwargs. These models expose a binary `/think` profile (`off`, `on`) because Qwen chat-template thinking is an on/off flag, not an OpenAI-style effort ladder.

    ```json5
    {
      models: {
        providers: {
          vllm: {
            models: [
              {
                id: "Qwen/Qwen3-8B",
                name: "Qwen3 8B",
                reasoning: true,
                compat: { thinkingFormat: "qwen-chat-template" },
              },
            ],
          },
        },
      },
    }
    ```

    OpenClaw maps `/think off` to:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "preserve_thinking": true
      }
    }
    ```

    Non-`off` thinking levels send `enable_thinking: true`. If your endpoint expects DashScope-style top-level flags instead, use `compat.thinkingFormat: "qwen"` to send `enable_thinking` at the request root.

  </Accordion>

  <Accordion title="Nemotron 3 thinking controls">
    For `vllm/nemotron-3-*` models with thinking off, the bundled plugin sends:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "force_nonempty_content": true
      }
    }
    ```

    To customize these values, set `chat_template_kwargs` under the model params. If you also set `params.extra_body.chat_template_kwargs`, that value wins because `extra_body` is the last request-body override.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "vllm/nemotron-3-super": {
              params: {
                chat_template_kwargs: {
                  enable_thinking: false,
                  force_nonempty_content: true,
                },
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Qwen tool calls appear as text">
    First confirm vLLM was started with the right tool-call parser and chat template for the model. vLLM documents `hermes` for Qwen2.5 models and `qwen3_xml` for Qwen3-Coder models.

    Symptoms: skills/tools never run, the assistant prints raw JSON/XML such as `{"name":"read","arguments":...}`, or vLLM returns an empty `tool_calls` array when OpenClaw sends `tool_choice: "auto"`.

    Some Qwen/vLLM combinations return structured tool calls only when the request uses `tool_choice: "required"`. Force it per model with `params.extra_body`:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "vllm/Qwen-Qwen2.5-Coder-32B-Instruct": {
              params: {
                extra_body: {
                  tool_choice: "required",
                },
              },
            },
          },
        },
      },
    }
    ```

    Replace the model id with the exact id from `openclaw models list --provider vllm`, or apply the same override from the CLI:

    ```bash
    openclaw config set agents.defaults.models '{"vllm/Qwen-Qwen2.5-Coder-32B-Instruct":{"params":{"extra_body":{"tool_choice":"required"}}}}' --strict-json --merge
    ```

    This is an opt-in workaround: it forces every turn with tools to make a tool call, so use it only for a dedicated model entry where that is acceptable. Do not set it as a global default for all vLLM models, and do not pair it with a proxy that converts arbitrary assistant text into executable tool calls.

  </Accordion>

  <Accordion title="Custom base URL">
    If your vLLM server runs on a non-default host or port, set `baseUrl` in the explicit provider config:

    ```json5
    {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://192.168.1.50:9000/v1",
            apiKey: "${VLLM_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            models: [
              {
                id: "my-custom-model",
                name: "Remote vLLM Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 64000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    }
    ```

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Slow first response or remote server timeout">
    For large local models, remote LAN hosts, or tailnet links, set a provider-scoped request timeout:

    ```json5
    {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://192.168.1.50:8000/v1",
            apiKey: "${VLLM_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            models: [{ id: "your-model-id", name: "Local vLLM Model" }],
          },
        },
      },
    }
    ```

    `timeoutSeconds` applies to vLLM model HTTP requests only: connection setup, response headers, body streaming, and the total guarded-fetch abort. It also raises the LLM idle/stream watchdog ceiling above the implicit ~120s default for this provider. Prefer this over increasing `agents.defaults.timeoutSeconds`, which controls the whole agent run.

  </Accordion>

  <Accordion title="Server not reachable">
    Check that the vLLM server is running and accessible:

    ```bash
    curl http://127.0.0.1:8000/v1/models
    ```

    If you see a connection error, verify the host, port, and that vLLM started in OpenAI-compatible server mode. OpenClaw trusts the exact configured `models.providers.vllm.baseUrl` origin for guarded model requests on loopback, LAN, and Tailscale endpoints. Metadata/link-local origins remain blocked without explicit opt-in. Set `models.providers.vllm.request.allowPrivateNetwork: true` only when vLLM requests must reach another private origin, or `false` to opt out of exact-origin trust.

  </Accordion>

  <Accordion title="Auth errors on requests">
    If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.vllm`.

    <Tip>
    If your vLLM server does not enforce auth, any non-empty value for `VLLM_API_KEY` works as an opt-in signal for OpenClaw.
    </Tip>

  </Accordion>

  <Accordion title="No models discovered">
    Auto-discovery requires `VLLM_API_KEY` to be set. If you have defined `models.providers.vllm`, OpenClaw uses only your declared models unless `agents.defaults.models` includes `"vllm/*": {}`.
  </Accordion>

  <Accordion title="Tools render as raw text">
    If a Qwen model prints JSON/XML tool syntax instead of executing a skill:

    - Start vLLM with the correct parser/template for that model.
    - Confirm the exact model id with `openclaw models list --provider vllm`.
    - Add a dedicated per-model `params.extra_body.tool_choice: "required"` override only if `tool_choice: "auto"` still returns empty or text-only tool calls.

  </Accordion>
</AccordionGroup>

<Warning>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="OpenAI" href="/providers/openai" icon="bolt">
    Native OpenAI provider and OpenAI-compatible route behavior.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and how to resolve them.
  </Card>
</CardGroup>
