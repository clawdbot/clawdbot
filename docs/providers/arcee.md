---
title: "Arcee AI"
summary: "Arcee AI setup (auth + model selection)"
read_when:
  - You want to use Arcee AI with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Arcee AI

[Arcee AI](https://arcee.ai) provides access to the Trinity family of mixture-of-experts models through an OpenAI-compatible API. All Trinity models are Apache 2.0 licensed.

Arcee AI models can be accessed directly via the Arcee platform or through [OpenRouter](/providers/openrouter).

| Property | Value                                                                                 |
| -------- | ------------------------------------------------------------------------------------- |
| Provider | `arcee`                                                                               |
| Auth     | `ARCEEAI_API_KEY` (direct) or `OPENROUTER_API_KEY` (via OpenRouter)                   |
| API      | OpenAI-compatible                                                                     |
| Base URL | `https://api.arcee.ai/api/v1` (direct) or `https://openrouter.ai/api/v1` (OpenRouter) |

## Getting started

<Tabs>
  <Tab title="Direct (Arcee platform)">
    <Steps>
      <Step title="Get an API key">
        Create an API key at [Arcee AI](https://chat.arcee.ai/).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice arceeai-api-key
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "arcee/trinity-large-thinking" },
            },
          },
        }
        ```
      </Step>
    </Steps>
  </Tab>

  <Tab title="Via OpenRouter">
    <Steps>
      <Step title="Get an API key">
        Create an API key at [OpenRouter](https://openrouter.ai/keys).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice arceeai-openrouter
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "arcee/trinity-large-thinking" },
            },
          },
        }
        ```

        The same model refs work for both direct and OpenRouter setups (for example `arcee/trinity-large-thinking`).
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Non-interactive setup

<Tabs>
  <Tab title="Direct (Arcee platform)">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice arceeai-api-key \
      --arceeai-api-key "$ARCEEAI_API_KEY"
    ```
  </Tab>

  <Tab title="Via OpenRouter">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice arceeai-openrouter \
      --openrouter-api-key "$OPENROUTER_API_KEY"
    ```
  </Tab>
</Tabs>

## Built-in catalog

OpenClaw currently ships this bundled Arcee catalog:

| Model ref                      | Name                   | Input | Context | Cost (in/out per 1M) | Notes                                     |
| ------------------------------ | ---------------------- | ----- | ------- | -------------------- | ----------------------------------------- |
| `arcee/trinity-large-thinking` | Trinity Large Thinking | text  | 256K    | $0.25 / $0.90        | Default model; reasoning enabled          |
| `arcee/trinity-large-preview`  | Trinity Large Preview  | text  | 128K    | $0.25 / $1.00        | General-purpose; 400B params, 13B active  |
| `arcee/trinity-mini`           | Trinity Mini 26B       | text  | 128K    | $0.045 / $0.15       | Fast and cost-efficient; function calling |

<Tip>
The onboarding preset sets `arcee/trinity-large-thinking` as the default model.
</Tip>

## Supported features

| Feature                                       | Supported                    |
| --------------------------------------------- | ---------------------------- |
| Streaming                                     | Yes                          |
| Tool use / function calling                   | Yes                          |
| Structured output (JSON mode and JSON schema) | Yes                          |
| Extended thinking                             | Yes (Trinity Large Thinking) |

<AccordionGroup>
  <Accordion title="Environment note">
    If the Gateway runs as a daemon (launchd/systemd), make sure `ARCEEAI_API_KEY`
    (or `OPENROUTER_API_KEY`) is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).
  </Accordion>

  <Accordion title="OpenRouter routing">
    When using Arcee models via OpenRouter, the same `arcee/*` model refs apply.
    OpenClaw handles routing transparently based on your auth choice. See the
    [OpenRouter provider docs](/providers/openrouter) for OpenRouter-specific
    configuration details.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="OpenRouter" href="/providers/openrouter" icon="shuffle">
    Access Arcee models and many others through a single API key.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
