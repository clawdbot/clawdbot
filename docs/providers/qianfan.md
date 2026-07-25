---
summary: "Use Qianfan's unified API to access many models in OpenClaw"
read_when:
  - You want a single API key for many LLMs
  - You need Baidu Qianfan setup guidance
title: "Qianfan"
---

Qianfan is Baidu's MaaS platform: a unified, OpenAI-compatible API that routes requests to many models behind a single endpoint and API key. OpenClaw ships it as the official external plugin `@openclaw/qianfan-provider`.

| Property      | Value                                    |
| ------------- | ---------------------------------------- |
| Provider      | `qianfan`                                |
| Auth          | `QIANFAN_API_KEY`                        |
| API           | OpenAI-compatible (`openai-completions`) |
| Base URL      | `https://qianfan.baidubce.com/v2`        |
| Default model | `qianfan/deepseek-v3.2`                  |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/qianfan-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Create a Baidu Cloud account">
    Sign up or log in at the [Qianfan Console](https://console.bce.baidu.com/qianfan/ais/console/apiKey) and ensure you have Qianfan API access enabled.
  </Step>
  <Step title="Generate an API key">
    Create a new application or select an existing one, then generate an API key. Baidu Cloud keys use the `bce-v3/ALTAK-...` format.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice qianfan-api-key
    ```

    Non-interactive runs read the key from `--qianfan-api-key <key>` or
    `QIANFAN_API_KEY`. Onboarding writes the provider config, adds the
    `QIANFAN` alias for the default model, and sets `qianfan/deepseek-v3.2`
    as the default model when none is configured.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider qianfan
    ```
  </Step>
</Steps>

## Built-in catalog

| Model ref                            | Input       | Context | Max output | Reasoning | Notes         |
| ------------------------------------ | ----------- | ------- | ---------- | --------- | ------------- |
| `qianfan/deepseek-v3.2`              | text        | 98,304  | 32,768     | Yes       | Default model |
| `qianfan/ernie-5.0-thinking-preview` | text, image | 119,000 | 64,000     | Yes       | Multimodal    |

The catalog is static; there is no live model discovery.

<Tip>
You only need to override `models.providers.qianfan` when you need a custom base URL or model metadata.
</Tip>

## Config example

```json5
{
  env: { QIANFAN_API_KEY: "bce-v3/ALTAK-..." },
  agents: {
    defaults: {
      model: { primary: "qianfan/deepseek-v3.2" },
      models: {
        "qianfan/deepseek-v3.2": { alias: "QIANFAN" },
      },
    },
  },
  models: {
    providers: {
      qianfan: {
        baseUrl: "https://qianfan.baidubce.com/v2",
        api: "openai-completions",
        models: [
          {
            id: "deepseek-v3.2",
            name: "DEEPSEEK V3.2",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 98304,
            maxTokens: 32768,
          },
          {
            id: "ernie-5.0-thinking-preview",
            name: "ERNIE-5.0-Thinking-Preview",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 119000,
            maxTokens: 64000,
          },
        ],
      },
    },
  },
}
```

<Note>
Model refs use the `qianfan/` prefix (for example `qianfan/deepseek-v3.2`).
</Note>

<AccordionGroup>
  <Accordion title="Transport and compatibility">
    Qianfan runs through the OpenAI-compatible transport path, not native OpenAI request shaping. Standard OpenAI SDK features work, but provider-specific parameters may not be forwarded.
  </Accordion>

  <Accordion title="Troubleshooting">
    - Ensure your API key starts with `bce-v3/ALTAK-` and has Qianfan API access enabled in the Baidu Cloud console.
    - If models are not listed, confirm your account has the Qianfan service activated.
    - Only change the base URL if you use a custom endpoint or proxy.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="Agent setup" href="/concepts/agent" icon="robot">
    Configuring agent defaults and model assignments.
  </Card>
  <Card title="Qianfan API docs" href="https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb" icon="arrow-up-right-from-square">
    Official Qianfan API documentation.
  </Card>
</CardGroup>
