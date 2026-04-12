---
summary: "Use Xiaomi MiMo models with OpenClaw"
read_when:
  - You want Xiaomi MiMo models in OpenClaw
  - You need XIAOMI_API_KEY setup
title: "Xiaomi MiMo"
---

# Xiaomi MiMo

Xiaomi MiMo is the API platform for **MiMo** models. OpenClaw uses the Xiaomi
OpenAI-compatible endpoint with API-key authentication.

| Property | Value                           |
| -------- | ------------------------------- |
| Provider | `xiaomi`                        |
| Auth     | `XIAOMI_API_KEY`                |
| API      | OpenAI-compatible               |
| Base URL | `https://api.xiaomimimo.com/v1` |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key in the [Xiaomi MiMo console](https://platform.xiaomimimo.com/#/console/api-keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice xiaomi-api-key
    ```

    Or pass the key directly:

    ```bash
    openclaw onboard --auth-choice xiaomi-api-key --xiaomi-api-key "$XIAOMI_API_KEY"
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider xiaomi
    ```
  </Step>
</Steps>

## Available models

| Model ref              | Input       | Context   | Max output | Reasoning | Notes         |
| ---------------------- | ----------- | --------- | ---------- | --------- | ------------- |
| `xiaomi/mimo-v2-flash` | text        | 262,144   | 8,192      | No        | Default model |
| `xiaomi/mimo-v2-pro`   | text        | 1,048,576 | 32,000     | Yes       | Large context |
| `xiaomi/mimo-v2-omni`  | text, image | 262,144   | 32,000     | Yes       | Multimodal    |

<Tip>
The default model ref is `xiaomi/mimo-v2-flash`. The provider is injected automatically when `XIAOMI_API_KEY` is set or an auth profile exists.
</Tip>

## Config example

```json5
{
  env: { XIAOMI_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "xiaomi/mimo-v2-flash" } } },
  models: {
    mode: "merge",
    providers: {
      xiaomi: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        apiKey: "XIAOMI_API_KEY",
        models: [
          {
            id: "mimo-v2-flash",
            name: "Xiaomi MiMo V2 Flash",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 8192,
          },
          {
            id: "mimo-v2-pro",
            name: "Xiaomi MiMo V2 Pro",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1048576,
            maxTokens: 32000,
          },
          {
            id: "mimo-v2-omni",
            name: "Xiaomi MiMo V2 Omni",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Auto-injection behavior">
    The `xiaomi` provider is injected automatically when `XIAOMI_API_KEY` is set in your environment or an auth profile exists. You do not need to manually configure the provider unless you want to override model metadata or the base URL.
  </Accordion>

  <Accordion title="Model details">
    - **mimo-v2-flash** — lightweight and fast, ideal for general-purpose text tasks. No reasoning support.
    - **mimo-v2-pro** — supports reasoning with a 1M token context window for long-document workloads.
    - **mimo-v2-omni** — reasoning-enabled multimodal model that accepts both text and image inputs.

    <Note>
    All models use the `xiaomi/` prefix (for example `xiaomi/mimo-v2-pro`).
    </Note>

  </Accordion>

  <Accordion title="Troubleshooting">
    - If models do not appear, confirm `XIAOMI_API_KEY` is set and valid.
    - When the Gateway runs as a daemon, ensure the key is available to that process (for example in `~/.openclaw/.env` or via `env.shellEnv`).

    <Warning>
    Keys set only in your interactive shell are not visible to daemon-managed gateway processes. Use `~/.openclaw/.env` or `env.shellEnv` config for persistent availability.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="Xiaomi MiMo console" href="https://platform.xiaomimimo.com" icon="arrow-up-right-from-square">
    Xiaomi MiMo dashboard and API key management.
  </Card>
</CardGroup>
