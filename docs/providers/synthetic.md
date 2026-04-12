---
summary: "Use Synthetic's Anthropic-compatible API in OpenClaw"
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: "Synthetic"
---

# Synthetic

[Synthetic](https://synthetic.new) exposes Anthropic-compatible endpoints.
OpenClaw registers it as the `synthetic` provider and uses the Anthropic
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
    Obtain a `SYNTHETIC_API_KEY` from your Synthetic account, or let the
    onboarding wizard prompt you for one.
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice synthetic-api-key
    ```
  </Step>
  <Step title="Verify the default model">
    After onboarding the default model is set to:
    ```
    synthetic/hf:MiniMaxAI/MiniMax-M2.5
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
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
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
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

## Model catalog

All Synthetic models use cost `0` (input/output/cache).

| Model ID                                               | Context window | Max tokens | Reasoning | Input        |
| ------------------------------------------------------ | -------------- | ---------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.5`                            | 192,000        | 65,536     | no        | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256,000        | 8,192      | yes       | text         |
| `hf:zai-org/GLM-4.7`                                   | 198,000        | 128,000    | no        | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128,000        | 8,192      | no        | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128,000        | 8,192      | no        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128,000        | 8,192      | no        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128,000        | 8,192      | no        | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159,000        | 8,192      | no        | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128,000        | 8,192      | no        | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524,000        | 8,192      | no        | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256,000        | 8,192      | no        | text         |
| `hf:moonshotai/Kimi-K2.5`                              | 256,000        | 8,192      | yes       | text + image |
| `hf:openai/gpt-oss-120b`                               | 128,000        | 8,192      | no        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256,000        | 8,192      | no        | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256,000        | 8,192      | no        | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250,000        | 8,192      | no        | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128,000        | 128,000    | no        | text         |
| `hf:zai-org/GLM-4.6`                                   | 198,000        | 128,000    | no        | text         |
| `hf:zai-org/GLM-5`                                     | 256,000        | 128,000    | yes       | text + image |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128,000        | 8,192      | no        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256,000        | 8,192      | yes       | text         |

<Tip>
Model refs use the form `synthetic/<modelId>`. Use
`openclaw models list --provider synthetic` to see all models available on your
account.
</Tip>

<AccordionGroup>
  <Accordion title="Model allowlist">
    If you enable a model allowlist (`agents.defaults.models`), add every
    Synthetic model you plan to use. Models not in the allowlist will be hidden
    from the agent.
  </Accordion>

  <Accordion title="Base URL override">
    If Synthetic changes its API endpoint, override the base URL in your config:

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

    Remember that OpenClaw appends `/v1` automatically.

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
