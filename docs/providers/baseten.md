---
summary: "Baseten setup for Inkling and hosted Model APIs"
title: "Baseten"
read_when:
  - You want to run Thinking Machines Lab's Inkling in OpenClaw
  - You want one OpenAI-compatible API for Baseten's hosted models
---

[Baseten Model APIs](https://docs.baseten.co/inference/model-apis/overview) provide hosted, OpenAI-compatible access to frontier models. The official external plugin uses authenticated discovery, so OpenClaw follows the complete model set enabled for your Baseten account. Its offline fallback contains every Model API available when this OpenClaw release was built.

| Property        | Value                                                    |
| --------------- | -------------------------------------------------------- |
| Provider id     | `baseten`                                                |
| Plugin          | official external package (`@openclaw/baseten-provider`) |
| Auth env var    | `BASETEN_API_KEY`                                        |
| Onboarding flag | `--auth-choice baseten-api-key`                          |
| Direct CLI flag | `--baseten-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                 |
| Base URL        | `https://inference.baseten.co/v1`                        |
| Default model   | `baseten/thinkingmachines/inkling`                       |

## Install plugin

```bash
openclaw plugins install @openclaw/baseten-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Create a Baseten account and API key">
    Baseten's Basic plan has no monthly platform fee; Model API calls are usage-priced. Create a key in [Baseten API key settings](https://app.baseten.co/settings/api_keys) and check current rates on the [pricing page](https://www.baseten.co/pricing).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice baseten-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice baseten-api-key \
  --baseten-api-key "$BASETEN_API_KEY"
```

```bash Env only
export BASETEN_API_KEY=...
```

    </CodeGroup>

  </Step>
  <Step title="Verify the live catalog">
    ```bash
    openclaw models list --provider baseten
    ```

    With usable auth, the plugin requests `GET /v1/models` and lists every model returned for the account. Without auth, it stays offline and uses the bundled fallback.

  </Step>
</Steps>

## Inkling

[Thinking Machines Lab's Inkling](https://thinkingmachines.ai/news/introducing-inkling/) is the default model. In OpenClaw it supports text and image input, tool calling, structured tool schemas, configurable reasoning effort, a 1.048M-token context window, and up to 32k output tokens:

```json5
{
  agents: {
    defaults: {
      model: { primary: "baseten/thinkingmachines/inkling" },
    },
  },
}
```

Use `/model baseten/thinkingmachines/inkling` to switch an existing chat.

## Bundled fallback catalog

The authenticated live catalog is authoritative. These rows keep setup and model selection useful before discovery succeeds:

| Model ref                                          | Input       | Context | Max output |
| -------------------------------------------------- | ----------- | ------: | ---------: |
| `baseten/deepseek-ai/DeepSeek-V4-Pro`              | text        |    262k |       262k |
| `baseten/zai-org/GLM-4.7`                          | text        |    200k |       200k |
| `baseten/zai-org/GLM-5`                            | text        |    202k |       202k |
| `baseten/zai-org/GLM-5.1`                          | text        |    202k |       202k |
| `baseten/zai-org/GLM-5.2`                          | text        |    202k |       202k |
| `baseten/thinkingmachines/inkling`                 | text, image |  1.048M |        32k |
| `baseten/moonshotai/Kimi-K2.5`                     | text, image |    262k |       262k |
| `baseten/moonshotai/Kimi-K2.6`                     | text, image |    262k |       262k |
| `baseten/moonshotai/Kimi-K2.7-Code`                | text, image |    262k |       262k |
| `baseten/nvidia/Nemotron-120B-A12B`                | text        |    202k |       202k |
| `baseten/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B` | text        |    202k |       202k |
| `baseten/openai/gpt-oss-120b`                      | text        |    128k |       128k |

All bundled models support tool calling and reasoning. OpenClaw maps its thinking levels to models with native `reasoning_effort`. Baseten's opt-in GLM, Kimi, and Nemotron models default to thinking off; most expose a binary off/on control, while GLM 5.2 exposes off, high, and max. OpenClaw sends these choices through Baseten's `chat_template_args.enable_thinking` control and, for GLM 5.2, the validated top-level `reasoning_effort` parameter.

<Note>
Baseten can add, remove, or change Model APIs independently of OpenClaw releases. The plugin refreshes model ids, context limits, output limits, and input, cached-input, and output pricing from the authenticated API while retaining model-specific OpenClaw transport policy.
</Note>

## Manual config

Most setups only need the API key. To pin the provider explicitly:

```json5
{
  env: { BASETEN_API_KEY: "..." },
  agents: {
    defaults: {
      model: { primary: "baseten/thinkingmachines/inkling" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      baseten: {
        baseUrl: "https://inference.baseten.co/v1",
        apiKey: "${BASETEN_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "thinkingmachines/inkling",
            name: "Inkling",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1048000,
            maxTokens: 32000,
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsUsageInStreaming: true,
              supportsStrictMode: true,
              supportsTools: true,
              supportsReasoningEffort: true,
              supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
              reasoningEffortMap: {
                off: "none",
                none: "none",
                adaptive: "xhigh",
                max: "xhigh",
              },
              maxTokensField: "max_tokens",
            },
          },
        ],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `BASETEN_API_KEY` is available to that process. A key exported only in an interactive shell is not visible to an already-running managed service.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Select OpenClaw reasoning effort levels.
  </Card>
  <Card title="Models CLI" href="/cli/models" icon="terminal">
    List, inspect, and select discovered models.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles and model-selection troubleshooting.
  </Card>
</CardGroup>
