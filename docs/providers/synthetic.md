---
summary: "Use Synthetic's Anthropic-compatible API in OpenClaw"
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: "Synthetic"
---

[Synthetic](https://synthetic.new) exposes Anthropic-compatible endpoints.
OpenClaw bundles it as the `synthetic` provider and uses the Anthropic
Messages API.

| Property | Value                                 |
| -------- | ------------------------------------- |
| Provider | `synthetic`                           |
| Auth     | `SYNTHETIC_API_KEY`                   |
| API      | Anthropic Messages                    |
| Base URL | `https://api.synthetic.new/anthropic` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Get a `SYNTHETIC_API_KEY` from your Synthetic account, or let onboarding
    prompt you for one.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice synthetic-api-key
    ```
  </Step>
  <Step title="Verify the default model">
    Onboarding sets the default model to:
    ```text
    synthetic/hf:MiniMaxAI/MiniMax-M3
    ```
  </Step>
</Steps>

<Warning>
OpenClaw's Anthropic client appends `/v1` to the base URL automatically, so use
`https://api.synthetic.new/anthropic` (not `/anthropic/v1`). If Synthetic
changes its base URL, override `models.providers.synthetic.baseUrl`.
</Warning>

## Config example

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M3" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M3": { alias: "MiniMax M3" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M3",
            name: "MiniMax M3",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

## Built-in catalog

All Synthetic models use cost `0` (input/output/cache). See Synthetic's
[current model list](https://dev.synthetic.new/docs/api/models) for service availability.

| Model ID                                            | Context window | Max tokens | Reasoning | Input        |
| --------------------------------------------------- | -------------- | ---------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M3`                           | 262,144        | 65,536     | yes       | text + image |
| `hf:moonshotai/Kimi-K2.7-Code`                      | 262,144        | 8,192      | yes       | text + image |
| `hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` | 262,144        | 8,192      | yes       | text         |
| `hf:openai/gpt-oss-120b`                            | 131,072        | 8,192      | yes       | text         |
| `hf:Qwen/Qwen3.6-27B`                               | 262,144        | 81,920     | yes       | text + image |
| `hf:zai-org/GLM-4.7-Flash`                          | 196,608        | 131,072    | yes       | text         |
| `hf:zai-org/GLM-5.2`                                | 524,288        | 131,072    | yes       | text         |

<Tip>
Model refs use the form `synthetic/<modelId>`. Use
`openclaw models list --provider synthetic` to see all models available on your
account.
</Tip>

<AccordionGroup>
  <Accordion title="Model allowlist">
    If you enable a model allowlist (`agents.defaults.modelPolicy.allow`), add every
    Synthetic model you plan to use. Models not in the allowlist are hidden
    from the agent.
  </Accordion>

  <Accordion title="Base URL override">
    If Synthetic changes its API endpoint, override the base URL:

    ```json5
    {
      models: {
        providers: {
          synthetic: {
            baseUrl: "https://new-api.synthetic.new/anthropic",
          },
        },
      },
    }
    ```

    OpenClaw still appends `/v1` automatically.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="Synthetic" href="https://synthetic.new" icon="arrow-up-right-from-square">
    Synthetic dashboard and API docs.
  </Card>
</CardGroup>
