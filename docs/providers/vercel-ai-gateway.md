---
title: "Vercel AI Gateway"
summary: "Vercel AI Gateway setup (auth + model selection)"
read_when:
  - You want to use Vercel AI Gateway with OpenClaw
  - You need the API key env var or CLI auth choice
---

# Vercel AI Gateway

The [Vercel AI Gateway](https://vercel.com/ai-gateway) provides a unified API to
access hundreds of models through a single endpoint.

| Property      | Value                            |
| ------------- | -------------------------------- |
| Provider      | `vercel-ai-gateway`              |
| Auth          | `AI_GATEWAY_API_KEY`             |
| API           | Anthropic Messages compatible    |
| Model catalog | Auto-discovered via `/v1/models` |

<Tip>
OpenClaw auto-discovers the Gateway `/v1/models` catalog, so
`/models vercel-ai-gateway` includes current model refs such as
`vercel-ai-gateway/openai/gpt-5.4` and
`vercel-ai-gateway/moonshotai/kimi-k2.6`.
</Tip>

## Getting started

<Steps>
  <Step title="Set the API key">
    Run onboarding and choose the AI Gateway auth option:

    ```bash
    openclaw onboard --auth-choice ai-gateway-api-key
    ```

  </Step>
  <Step title="Set a default model">
    Add the model to your OpenClaw config:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
        },
      },
    }
    ```

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider vercel-ai-gateway
    ```
  </Step>
</Steps>

## Non-interactive example

For scripted or CI setups, pass all values on the command line:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## Model ID shorthand

OpenClaw accepts Vercel Claude shorthand model refs and normalizes them at
runtime:

| Shorthand input                     | Normalized model ref                          |
| ----------------------------------- | --------------------------------------------- |
| `vercel-ai-gateway/claude-opus-4.6` | `vercel-ai-gateway/anthropic/claude-opus-4.6` |
| `vercel-ai-gateway/opus-4.6`        | `vercel-ai-gateway/anthropic/claude-opus-4-6` |

<Tip>
You can use either the shorthand or the fully qualified model ref in your
configuration. OpenClaw resolves the canonical form automatically.
</Tip>

## Advanced notes

<AccordionGroup>
  <Accordion title="Environment variable for daemon processes">
    If the OpenClaw Gateway runs as a daemon (launchd/systemd), make sure
    `AI_GATEWAY_API_KEY` is available to that process.

    <Warning>
    A key set only in `~/.profile` will not be visible to a launchd/systemd
    daemon unless that environment is explicitly imported. Set the key in
    `~/.openclaw/.env` or via `env.shellEnv` to ensure the gateway process can
    read it.
    </Warning>

  </Accordion>

  <Accordion title="Provider routing">
    Vercel AI Gateway routes requests to the upstream provider based on the model
    ref prefix. For example, `vercel-ai-gateway/anthropic/claude-opus-4.6` routes
    through Anthropic, while `vercel-ai-gateway/openai/gpt-5.4` routes through
    OpenAI and `vercel-ai-gateway/moonshotai/kimi-k2.6` routes through
    MoonshotAI. Your single `AI_GATEWAY_API_KEY` handles authentication for all
    upstream providers.
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
