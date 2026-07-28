---
summary: "Poolside (Laguna models) setup (auth + model selection)"
read_when:
  - You want to use Poolside Laguna models with OpenClaw
  - You need the Poolside API key env var or CLI auth choice
title: "Poolside"
---

[Poolside](https://poolside.ai) provides agentic coding foundation models (the
Laguna family) through an OpenAI-compatible API. Install the official Poolside
provider plugin from ClawHub to make Laguna models available in OpenClaw's model
catalog without custom provider entries in `openclaw.json`.

| Property | Value                         |
| -------- | ----------------------------- |
| Provider | `poolside`                    |
| Plugin   | `clawhub:@poolside/openclaw-provider` |
| Auth     | `POOLSIDE_API_KEY`            |
| API      | OpenAI-compatible             |
| Base URL | `https://inference.poolside.ai/v1` |

## Install plugin

```bash
openclaw plugins install clawhub:@poolside/openclaw-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get a Poolside API key">
    Go to [platform.poolside.ai](https://platform.poolside.ai/), sign in with
    Google or GitHub, open the **API Keys** tab, and click **New key**. Copy
    the key and store it securely — it is shown only once.
  </Step>
  <Step title="Authenticate with OpenClaw">
    ```bash
    openclaw onboard --auth-choice poolside-api-key
    ```

    Or, for a headless gateway, add the key to `~/.openclaw/.env`:

    ```bash
    POOLSIDE_API_KEY=<api-key>
    ```

  </Step>
  <Step title="Set the default model">
    ```bash
    openclaw models set poolside/laguna-s-2.1
    ```

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider poolside
    ```

    Run `openclaw models status` to confirm a `poolside/` model is the primary
    model and provider auth is valid.

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice poolside-api-key \
      --poolside-api-key "$POOLSIDE_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `POOLSIDE_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

Every Laguna model supports text input, tool calling, and native reasoning
(thinking on or off per request).

| Model ref                    | Name                | Input | Context   | Notes                    |
| ---------------------------- | ------------------- | ----- | --------- | ------------------------ |
| `poolside/laguna-s-2.1`      | Laguna S 2.1        | text  | 1M tokens | Default; 118B MoE        |
| `poolside/laguna-s-2.1:free` | Laguna S 2.1 (free) | text  | 1M tokens | Rate-limited free tier   |

To switch models for a single chat session without changing the default, use
`openclaw agent --model poolside/laguna-s-2.1 --message "..."`.

<Tip>
See [Supported models](https://docs.poolside.ai/get-started/supported-models) for
the full Laguna model family, including Laguna XS 2.1 and Laguna M.1. Run
`openclaw models list --all --provider poolside` to inspect the plugin's
complete catalog.
</Tip>

<Note>
Poolside Platform serves the API at `https://inference.poolside.ai/v1`. For a
self-managed Poolside deployment, set the provider `baseUrl` to the
deployment's OpenAI-compatible endpoint (ending in `/openai/v1`).
</Note>

## Config example

```json5
{
  env: { POOLSIDE_API_KEY: "<api-key>" },
  agents: {
    defaults: {
      model: { primary: "poolside/laguna-s-2.1" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Provider rules, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
  <Card title="Poolside API" href="https://docs.poolside.ai/api/overview" icon="arrow-up-right-from-square">
    API keys, base URLs, and request examples.
  </Card>
</CardGroup>
