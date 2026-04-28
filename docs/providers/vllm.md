---
summary: "Run OpenClaw with vLLM (OpenAI-compatible local server)"
read_when:
  - You want to run OpenClaw against a local vLLM server
  - You want OpenAI-compatible /v1 endpoints with your own models
title: "vLLM"
---

vLLM can serve open-source (and some custom) models via an **OpenAI-compatible** HTTP API. OpenClaw connects to vLLM using the `openai-completions` API.

OpenClaw can also **auto-discover** available models from vLLM when you opt in with `VLLM_API_KEY` (any value works if your server does not enforce auth) and you do not define an explicit `models.providers.vllm` entry.

OpenClaw treats `vllm` as a local OpenAI-compatible provider that supports
streamed usage accounting, so status/context token counts can update from
`stream_options.include_usage` responses.

| Property         | Value                                    |
| ---------------- | ---------------------------------------- |
| Provider ID      | `vllm`                                   |
| API              | `openai-completions` (OpenAI-compatible) |
| Auth             | `VLLM_API_KEY` environment variable      |
| Default base URL | `http://127.0.0.1:8000/v1`               |

## Getting started

<Steps>
  <Step title="Start vLLM with an OpenAI-compatible server">
    Your base URL should expose `/v1` endpoints (e.g. `/v1/models`, `/v1/chat/completions`). vLLM commonly runs on:

    ```
    http://127.0.0.1:8000/v1
    ```

  </Step>
  <Step title="Set the API key environment variable">
    Any value works if your server does not enforce auth:

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

## Model discovery (implicit provider)

When `VLLM_API_KEY` is set (or an auth profile exists) and you **do not** define `models.providers.vllm`, OpenClaw queries:

```
GET http://127.0.0.1:8000/v1/models
```

and converts the returned IDs into model entries.

<Note>
If you set `models.providers.vllm` explicitly, auto-discovery is skipped and you must define models manually.
</Note>

## Explicit configuration (manual models)

Use explicit config when:

- vLLM runs on a different host or port
- You want to pin `contextWindow` or `maxTokens` values
- Your server requires a real API key (or you want to control headers)
- You connect to a trusted loopback, LAN, or Tailscale vLLM endpoint

```json5
{
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${VLLM_API_KEY}",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        timeoutSeconds: 300, // Optional: extend connect/header/body/request timeout for slow local models
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

## Advanced configuration

<AccordionGroup>
  <Accordion title="Proxy-style behavior">
    vLLM is treated as a proxy-style OpenAI-compatible `/v1` backend, not a native
    OpenAI endpoint. This means:

    | Behavior | Applied? |
    |----------|----------|
    | Native OpenAI request shaping | No |
    | `service_tier` | Not sent |
    | Responses `store` | Not sent |
    | Prompt-cache hints | Not sent |
    | OpenAI reasoning-compat payload shaping | Not applied |
    | Hidden OpenClaw attribution headers | Not injected on custom base URLs |

  </Accordion>

  <Accordion title="Qwen thinking controls">
    For Qwen models served through vLLM, set
    `params.qwenThinkingFormat: "chat-template"` on the model entry when the
    server expects Qwen chat-template kwargs. OpenClaw maps `/think off` to:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "preserve_thinking": true
      }
    }
    ```

    Non-`off` thinking levels send `enable_thinking: true`. If your endpoint
    expects DashScope-style top-level flags instead, use
    `params.qwenThinkingFormat: "top-level"` to send `enable_thinking` at the
    request root. Snake-case `params.qwen_thinking_format` is also accepted.

  </Accordion>

  <Accordion title="Nemotron 3 thinking controls">
    vLLM/Nemotron 3 can use chat-template kwargs to control whether reasoning is
    returned as hidden reasoning or visible answer text. When an OpenClaw session
    uses `vllm/nemotron-3-*` with thinking off, the bundled vLLM plugin sends:

    ```json
    {
      "chat_template_kwargs": {
        "enable_thinking": false,
        "force_nonempty_content": true
      }
    }
    ```

    To customize these values, set `chat_template_kwargs` under the model params.
    If you also set `params.extra_body.chat_template_kwargs`, that value has
    final precedence because `extra_body` is the last request-body override.

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
    First make sure vLLM was started with the right tool-call parser and chat
    template for the model. For example, vLLM documents `hermes` for Qwen2.5
    models and `qwen3_xml` for Qwen3-Coder models.

    Symptoms:

    - skills or tools never run
    - the assistant prints raw JSON/XML such as `{"name":"read","arguments":...}`
    - vLLM returns an empty `tool_calls` array when OpenClaw sends
      `tool_choice: "auto"`

    Some Qwen/vLLM combinations return structured tool calls only when the
    request uses `tool_choice: "required"`. For those model entries, force the
    OpenAI-compatible request field with `params.extra_body`:

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

    Replace `Qwen-Qwen2.5-Coder-32B-Instruct` with the exact id returned by:

    ```bash
    openclaw models list --provider vllm
    ```

    You can apply the same override from the CLI:

    ```bash
    openclaw config set agents.defaults.models '{"vllm/Qwen-Qwen2.5-Coder-32B-Instruct":{"params":{"extra_body":{"tool_choice":"required"}}}}' --strict-json --merge
    ```

    This is an opt-in compatibility workaround. It makes every model turn with
    tools require a tool call, so use it only for a dedicated local model entry
    where that behavior is acceptable. Do not use it as a global default for all
    vLLM models, and do not use a proxy that blindly converts arbitrary
    assistant text into executable tool calls.

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
            request: { allowPrivateNetwork: true },
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
    For large local models, remote LAN hosts, or tailnet links, set a
    provider-scoped request timeout:

    ```json5
    {
      models: {
        providers: {
          vllm: {
            baseUrl: "http://192.168.1.50:8000/v1",
            apiKey: "${VLLM_API_KEY}",
            api: "openai-completions",
            request: { allowPrivateNetwork: true },
            timeoutSeconds: 300,
            models: [{ id: "your-model-id", name: "Local vLLM Model" }],
          },
        },
      },
    }
    ```

    `timeoutSeconds` applies to vLLM model HTTP requests only, including
    connection setup, response headers, body streaming, and the total
    guarded-fetch abort. Prefer this before increasing
    `agents.defaults.timeoutSeconds`, which controls the whole agent run.

  </Accordion>

  <Accordion title="Server not reachable">
    Check that the vLLM server is running and accessible:

    ```bash
    curl http://127.0.0.1:8000/v1/models
    ```

    If you see a connection error, verify the host, port, and that vLLM started with the OpenAI-compatible server mode.
    For explicit loopback, LAN, or Tailscale endpoints, also set
    `models.providers.vllm.request.allowPrivateNetwork: true`; provider
    requests block private-network URLs by default unless the provider is
    explicitly trusted.

  </Accordion>

  <Accordion title="Auth errors on requests">
    If requests fail with auth errors, set a real `VLLM_API_KEY` that matches your server configuration, or configure the provider explicitly under `models.providers.vllm`.

    <Tip>
    If your vLLM server does not enforce auth, any non-empty value for `VLLM_API_KEY` works as an opt-in signal for OpenClaw.
    </Tip>

  </Accordion>

  <Accordion title="No models discovered">
    Auto-discovery requires `VLLM_API_KEY` to be set **and** no explicit `models.providers.vllm` config entry. If you have defined the provider manually, OpenClaw skips discovery and uses only your declared models.
  </Accordion>

  <Accordion title="Tools render as raw text">
    If a Qwen model prints JSON/XML tool syntax instead of executing a skill,
    check the Qwen guidance in Advanced configuration above. The usual fix is:

    - start vLLM with the correct parser/template for that model
    - confirm the exact model id with `openclaw models list --provider vllm`
    - add a dedicated per-model `params.extra_body.tool_choice: "required"`
      override only if `tool_choice: "auto"` still returns empty or text-only
      tool calls

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
