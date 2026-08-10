---
summary: "Use Poolside Laguna models with OpenClaw"
read_when:
  - You want to use Poolside Laguna models with OpenClaw
  - You need the Poolside provider plugin, API key, or endpoint configuration
title: "Poolside"
---

Poolside publishes a provider plugin for its Laguna model family through the
ClawHub community catalog.

| Property                 | Value                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Provider id              | `poolside`                                                                             |
| Plugin                   | [`@poolside/openclaw-provider`](https://clawhub.ai/poolside/plugins/openclaw-provider) |
| Auth env var             | `POOLSIDE_API_KEY`                                                                     |
| Onboarding flag          | `--auth-choice poolside-api-key`                                                       |
| Direct CLI flag          | `--poolside-api-key <key>`                                                             |
| API                      | OpenAI-compatible Chat Completions                                                     |
| Default base URL         | `https://inference.poolside.ai/v1`                                                     |
| Default model            | `poolside/laguna-s-2.1`                                                                |
| Minimum OpenClaw version | `2026.7.1-2` or later                                                                  |

## Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install clawhub:@poolside/openclaw-provider
    openclaw gateway restart
    ```

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice poolside-api-key
    ```

    Enter your [Poolside Platform](https://platform.poolside.ai/) API key when
    prompted. Onboarding configures `poolside/laguna-s-2.1` as the default
    model unless you already have an explicit primary model.

  </Step>
  <Step title="Verify the setup">
    ```bash
    openclaw models list --provider poolside
    openclaw models status
    ```

  </Step>
</Steps>

## Built-in catalog

The plugin ships a static Laguna catalog. Every listed model supports text
input, tool calling, and reasoning, with up to 32,768 output tokens.

| Model ref                     | Context window | Max output |
| ----------------------------- | -------------- | ---------- |
| `poolside/laguna-s-2.1`       | 262,144        | 32,768     |
| `poolside/laguna-s-2.1:fast`  | 1,048,576      | 32,768     |
| `poolside/laguna-xs-2.1`      | 262,144        | 32,768     |
| `poolside/laguna-xs-2.1:fast` | 262,144        | 32,768     |
| `poolside/laguna-m.1`         | 262,144        | 32,768     |
| `poolside/laguna-m.1:fast`    | 262,144        | 32,768     |

The catalog is static. `openclaw models list --provider poolside` shows these
six entries and does not query the configured endpoint for additional models.

## Use self-managed Poolside inference

Set the provider base URL to your model's OpenAI-compatible endpoint:

```bash
openclaw config set models.providers.poolside.baseUrl "https://<model-hostname>/v1"
openclaw gateway restart
```

Set `POOLSIDE_API_KEY` for the Gateway process. Use the endpoint's API key when
it requires authentication:

```bash
POOLSIDE_API_KEY=<api-key>
```

If the endpoint does not require authentication, use any non-secret placeholder
value:

```bash
POOLSIDE_API_KEY=poolside-local
```

For a managed Gateway, add the value to the global runtime dotenv file at
`$OPENCLAW_STATE_DIR/.env`, which defaults to `~/.openclaw/.env`.

If the endpoint serves a model ID outside the built-in catalog, set its full
OpenClaw model ref explicitly:

```bash
openclaw models set poolside/<model-id>
```

The plugin accepts explicit model IDs that are not in its static catalog. They
remain absent from `openclaw models list --provider poolside`.

## Self-managed config example

```json5
{
  agents: {
    defaults: {
      model: { primary: "poolside/<model-id>" },
    },
  },
  models: {
    providers: {
      poolside: {
        baseUrl: "https://<model-hostname>/v1",
      },
    },
  },
}
```

## Behavior notes

<AccordionGroup>
  <Accordion title="Sampling parameters">
    Laguna uses a temperature-only sampling contract. When a request does not
    specify `temperature`, the plugin sets it to `0.7`. The plugin removes
    `top_p`, `top_k`, `min_p`, `presence_penalty`, `frequency_penalty`, and `n`
    before sending the request.

  </Accordion>
</AccordionGroup>

## Troubleshooting

- No Poolside models: Verify the provider plugin is installed, restart the
  Gateway, then run `openclaw models list --provider poolside`.
- Provider authentication errors: Run `openclaw models status`; for a
  self-managed endpoint, also verify that `POOLSIDE_API_KEY` and the configured
  base URL are visible to the Gateway process.
- Unknown self-managed model: Set the model as `poolside/<model-id>`. The
  static catalog does not discover endpoint-specific model IDs.

## Related

- [Poolside documentation](https://docs.poolside.ai/)
- [Model providers](/concepts/model-providers)
- [Provider directory](/providers/index)
- [Poolside Agent through ACPX](/tools/acp-agents)
