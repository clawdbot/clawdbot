---
summary: "Fireworks setup (auth + model selection)"
title: "Fireworks"
read_when:
  - You want to use Fireworks with OpenClaw
  - You need the Fireworks API key env var or default model id
---

[Fireworks](https://fireworks.ai) exposes open-weight and routed models through an OpenAI-compatible API. OpenClaw includes a bundled Fireworks provider plugin.

| Property      | Value                                                  |
| ------------- | ------------------------------------------------------ |
| Provider      | `fireworks`                                            |
| Auth          | `FIREWORKS_API_KEY`                                    |
| API           | OpenAI-compatible chat/completions                     |
| Base URL      | `https://api.fireworks.ai/inference/v1`                |
| Default model | `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` |

## Getting started

<Steps>
  <Step title="Set up Fireworks auth through onboarding">
    ```bash
    openclaw onboard --auth-choice fireworks-api-key
    ```

    This stores your Fireworks key in OpenClaw config and sets the Fire Pass starter model as the default.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider fireworks
    ```
  </Step>
</Steps>

## Non-interactive example

For scripted or CI setups, pass all values on the command line:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY" \
  --skip-health \
  --accept-risk
```

## Built-in catalog

| Model ref                                              | Name                        | Input      | Context | Max output | Notes                                                                                                                                               |
| ------------------------------------------------------ | --------------------------- | ---------- | ------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fireworks/accounts/fireworks/models/kimi-k2p6`        | Kimi K2.6                   | text,image | 262,144 | 262,144    | Latest Kimi model on Fireworks. Thinking is disabled for Fireworks K2.6 requests; route through Moonshot directly if you need Kimi thinking output. |
| `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` | Kimi K2.5 Turbo (Fire Pass) | text,image | 256,000 | 256,000    | Default bundled starter model on Fireworks                                                                                                          |

<Tip>
If Fireworks publishes a newer model such as a fresh Qwen or Gemma release, you can switch to it directly by using its Fireworks model id without waiting for a bundled catalog update.
</Tip>

## Custom Fireworks model ids

OpenClaw accepts dynamic Fireworks model ids too. Use the exact model or router id shown by Fireworks and prefix it with `fireworks/`.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="How model id prefixing works">
    Every Fireworks model ref in OpenClaw starts with `fireworks/` followed by the exact id or router path from the Fireworks platform. For example:

    - Router model: `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo`
    - Direct model: `fireworks/accounts/fireworks/models/<model-name>`

    OpenClaw strips the `fireworks/` prefix when building the API request and sends the remaining path to the Fireworks endpoint.

  </Accordion>

  <Accordion title="Environment note">
    If the Gateway runs outside your interactive shell, make sure `FIREWORKS_API_KEY` is available to that process too.

    <Warning>
    A key sitting only in `~/.profile` will not help a launchd/systemd daemon unless that environment is imported there as well. Set the key in `~/.openclaw/.env` or via `env.shellEnv` to ensure the gateway process can read it.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
