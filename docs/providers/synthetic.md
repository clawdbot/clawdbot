---
summary: "Use Synthetic's Anthropic-compatible API in OpenClaw"
read_when:
  - You want to use Synthetic as a model provider
  - You need a Synthetic API key or base URL setup
title: "Synthetic"
---

[Synthetic](https://synthetic.new) exposes Anthropic-compatible endpoints.
OpenClaw provides it through the official `@openclaw/synthetic-provider`
plugin and uses the Anthropic Messages API.

| Property | Value                                 |
| -------- | ------------------------------------- |
| Provider | `synthetic`                           |
| Auth     | `SYNTHETIC_API_KEY`                   |
| API      | Anthropic Messages                    |
| Base URL | `https://api.synthetic.new/anthropic` |

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/synthetic-provider
    openclaw gateway restart
    ```
  </Step>
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
  env: { vars: { SYNTHETIC_API_KEY: "sk-..." } },
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

## Model discovery

With a Synthetic credential, OpenClaw discovers current text models from
Synthetic's [`/openai/v1/models` API](https://dev.synthetic.new/docs/openai/models).
Inference still uses the Anthropic Messages API. Newly advertised models, including
small models and `syn:` aliases, do not need an OpenClaw catalog update.

The live catalog supplies context and output limits, image input, reasoning,
tool support, and usage-based token prices. Those prices are estimates, not a
subscription bill. See Synthetic's [current model list](https://dev.synthetic.new/docs/api/models)
for availability and its recommended aliases.

Offline catalog generation and unavailable or unusable discovery responses use
the bundled seed models. Your selected model is not changed automatically.
When you override the inference base URL, OpenClaw skips Synthetic's fixed
discovery URL so a proxy credential is not sent to Synthetic.

<Tip>
Model refs use the form `synthetic/<modelId>`. Use
`openclaw models list --provider synthetic` to inspect your configured models.
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
