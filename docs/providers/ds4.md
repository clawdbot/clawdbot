---
summary: "Run OpenClaw through ds4, a local DeepSeek V4 Flash OpenAI-compatible server"
read_when:
  - You want to run OpenClaw against antirez/ds4
  - You want a local DeepSeek V4 Flash backend with tool calls
  - You need the OpenClaw config for ds4-server
title: "ds4"
---

[ds4](https://github.com/antirez/ds4) serves DeepSeek V4 Flash from a local
Metal backend with an OpenAI-compatible `/v1` API. OpenClaw connects to ds4
through the generic `openai-completions` provider family.

ds4 is not a bundled OpenClaw provider plugin. Configure it under
`models.providers.ds4`, then select `ds4/deepseek-v4-flash`.

- Provider id: `ds4`
- Plugin: none
- API: OpenAI-compatible Chat Completions (`openai-completions`)
- Suggested base URL: `http://127.0.0.1:18000/v1`
- Model id: `deepseek-v4-flash`
- Tool calls: supported through OpenAI-style `tools` and `tool_calls`
- Reasoning: DeepSeek-style `thinking` and `reasoning_effort`

## Requirements

- macOS with Metal support.
- A working ds4 checkout with `ds4-server` and the DeepSeek V4 Flash GGUF file.
- Enough memory for the context you choose. Larger `--ctx` values allocate more
  KV memory when the server starts.

<Warning>
OpenClaw agent turns include tool schemas and workspace context. A tiny context
such as `--ctx 4096` can pass direct curl tests but fail full agent runs with
`500 prompt exceeds context`. Use at least `--ctx 32768` for agent and tool
smoke tests. Use `--ctx 393216` only when you have enough memory and want ds4
Think Max behavior.
</Warning>

## Quickstart

<Steps>
  <Step title="Start ds4-server">
    Replace `<DS4_DIR>` with your ds4 checkout path.

    ```bash
    <DS4_DIR>/ds4-server \
      --model <DS4_DIR>/ds4flash.gguf \
      --host 127.0.0.1 \
      --port 18000 \
      --ctx 32768 \
      --tokens 128
    ```

  </Step>
  <Step title="Verify the OpenAI-compatible endpoint">
    ```bash
    curl http://127.0.0.1:18000/v1/models
    ```

    The response should include `deepseek-v4-flash`.

  </Step>
  <Step title="Add the OpenClaw provider config">
    Add the config from [Full config](#full-config), then run a one-shot model
    check:

    ```bash
    openclaw infer model run \
      --local \
      --model ds4/deepseek-v4-flash \
      --thinking off \
      --prompt "Reply with exactly: openclaw-ds4-ok" \
      --json
    ```

  </Step>
</Steps>

## Full config

Use this config when ds4 is already running on `127.0.0.1:18000`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "ds4/deepseek-v4-flash" },
      models: {
        "ds4/deepseek-v4-flash": {
          alias: "DS4 local",
        },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      ds4: {
        baseUrl: "http://127.0.0.1:18000/v1",
        apiKey: "ds4-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash (ds4)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 128,
            compat: {
              supportsUsageInStreaming: true,
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
              supportsStrictMode: false,
              thinkingFormat: "deepseek",
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            },
          },
        ],
      },
    },
  },
}
```

Keep `contextWindow` aligned with the `ds4-server --ctx` value. Keep `maxTokens`
aligned with `--tokens` unless you intentionally want OpenClaw to request less
output than the server default.

## On-demand startup

OpenClaw can start ds4 only when a `ds4/...` model is selected. Add
`localService` to the same provider entry:

```json5
{
  models: {
    providers: {
      ds4: {
        baseUrl: "http://127.0.0.1:18000/v1",
        apiKey: "ds4-local",
        api: "openai-completions",
        timeoutSeconds: 300,
        localService: {
          command: "<DS4_DIR>/ds4-server",
          args: [
            "--model",
            "<DS4_DIR>/ds4flash.gguf",
            "--host",
            "127.0.0.1",
            "--port",
            "18000",
            "--ctx",
            "32768",
            "--tokens",
            "128",
          ],
          cwd: "<DS4_DIR>",
          healthUrl: "http://127.0.0.1:18000/v1/models",
          readyTimeoutMs: 300000,
          idleStopMs: 0,
        },
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash (ds4)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32768,
            maxTokens: 128,
            compat: {
              supportsUsageInStreaming: true,
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
              supportsStrictMode: false,
              thinkingFormat: "deepseek",
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            },
          },
        ],
      },
    },
  },
}
```

`command` must be an absolute executable path. Shell lookup and `~` expansion are
not used. See [Local model services](/gateway/local-model-services) for every
`localService` field.

## Think Max

ds4 applies Think Max only when both conditions are true:

- `ds4-server` starts with `--ctx 393216` or higher.
- The request uses `reasoning_effort: "max"` or the equivalent ds4 effort field.

If you run that large context, update both the server flags and OpenClaw model
metadata:

```json5
{
  contextWindow: 393216,
  maxTokens: 384000,
  compat: {
    supportsUsageInStreaming: true,
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    thinkingFormat: "deepseek",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
}
```

## Test

Start with a direct HTTP check:

```bash
curl http://127.0.0.1:18000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Reply with exactly: ds4-ok"}],"max_tokens":16,"stream":false,"thinking":{"type":"disabled"}}'
```

Then test OpenClaw model routing:

```bash
openclaw infer model run \
  --local \
  --model ds4/deepseek-v4-flash \
  --thinking off \
  --prompt "Reply with exactly: openclaw-ds4-ok" \
  --json
```

For a full agent and tool-call smoke, use a context of at least 32768:

```bash
openclaw agent \
  --local \
  --session-id ds4-tool-smoke \
  --model ds4/deepseek-v4-flash \
  --thinking off \
  --message "Use the shell command pwd once, then reply exactly: tool-ok <output>" \
  --json \
  --timeout 240
```

Expected result:

- `executionTrace.winnerProvider` is `ds4`
- `executionTrace.winnerModel` is `deepseek-v4-flash`
- `toolSummary.calls` is at least `1`
- `finalAssistantVisibleText` starts with `tool-ok`

## Troubleshooting

<AccordionGroup>
  <Accordion title="curl /v1/models cannot connect">
    ds4 is not running or not bound to the host and port in `baseUrl`. Start
    `ds4-server`, then retry:

    ```bash
    curl http://127.0.0.1:18000/v1/models
    ```

  </Accordion>

  <Accordion title="500 prompt exceeds context">
    The configured `--ctx` is too small for the OpenClaw turn. Raise
    `ds4-server --ctx`, then update `models.providers.ds4.models[].contextWindow`
    to match. Full agent turns with tools need substantially more context than a
    direct one-message curl request.
  </Accordion>

  <Accordion title="Think Max does not activate">
    ds4 only uses Think Max when `--ctx` is at least `393216` and the request
    asks for `reasoning_effort: "max"`. Smaller contexts fall back to high
    reasoning.
  </Accordion>

  <Accordion title="The first request is slow">
    ds4 has a cold Metal residency and model warmup phase. Use
    `localService.readyTimeoutMs: 300000` when OpenClaw starts the server on
    demand.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Local model services" href="/gateway/local-model-services" icon="play">
    Start local model servers on demand before model requests.
  </Card>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Choose and operate local model backends.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Configure provider refs, auth, and failover.
  </Card>
  <Card title="DeepSeek" href="/providers/deepseek" icon="brain">
    Native DeepSeek provider behavior and thinking controls.
  </Card>
</CardGroup>
