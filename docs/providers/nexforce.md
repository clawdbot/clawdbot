---
summary: "Nexforce Router setup (auth + model selection)"
title: "Nexforce Router"
read_when:
  - You want one API key for many LLMs
  - You want Latin American local billing and compliance for AI inference
  - You want automatic fallback and per-key cost control
---

Nexforce Router is Latin America's largest AI inference router. One
OpenAI-compatible endpoint routes to Anthropic, OpenAI, Google, DeepSeek,
Moonshot, Zhipu, and Cloudflare Workers AI models behind a single API key, with
per-key fallback chains and spend caps.

| Property | Value                                  |
| -------- | -------------------------------------- |
| Provider | `nexforce`                             |
| Auth     | `NEXFORCE_API_KEY`                     |
| API      | OpenAI-compatible                      |
| Base URL | `https://router.nexforce.ai/v1`        |
| Models   | `https://router.nexforce.ai/v1/models` |

For teams in the region, Nexforce handles billing and compliance locally for
each country, so you get compliant, locally-issued invoices and payment
infrastructure without FX or foreign-procurement friction.

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/nexforce-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at
    [marketplace.nexforce.ai](https://marketplace.nexforce.ai/workspace/ai-gateway/ai-gateway-keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice nexforce-api-key
    ```

    Prompts for your API key and sets `nexforce/smart-route` as the default
    model. `smart-route` lets the router pick an equivalent model per request
    while preserving the required capabilities.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider nexforce
    ```

    OpenClaw discovers the live catalog from the router's public `/v1/models`
    endpoint. To inspect the plugin's static fallback catalog without a running
    Gateway:

    ```bash
    openclaw models list --all --provider nexforce
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice nexforce-api-key \
      --nexforce-api-key "$NEXFORCE_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `NEXFORCE_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

These bundled fallback models are available before live catalog discovery, and
are also the recommended agentic (tool-calling) set. Any other model the router
serves, including the full per-vendor catalogs, resolves dynamically from the
live `/v1/models` endpoint.

| Model ref                              | Name                 | Input      | Context   | Max output | Notes                                |
| -------------------------------------- | -------------------- | ---------- | --------- | ---------- | ------------------------------------ |
| `nexforce/smart-route`                 | Nexforce Smart Route | text       | 200,000   | 128,000    | Default; router picks the best model |
| `nexforce/anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6    | text+image | 1,000,000 | 128,000    | Agentic fallback (Anthropic)         |
| `nexforce/openai/gpt-5.4`              | GPT-5.4              | text+image | 1,050,000 | 128,000    | Agentic fallback (OpenAI)            |
| `nexforce/deepseek/deepseek-v4-flash`  | DeepSeek V4 Flash    | text       | 1,000,000 | 384,000    | Cheap auxiliary model                |
| `nexforce/google/gemini-3.6-flash`     | Gemini 3.6 Flash     | text+image | 1,048,576 | 65,536     | Agentic fallback (Google)            |
| `nexforce/z-ai/glm-5`                  | GLM-5                | text       | 204,800   | 131,072    | Agentic fallback (Zhipu)             |

<Note>
Model refs include the provider prefix: `nexforce/<upstream-provider>/<model>`.
For example `nexforce/openai/gpt-5.4` or `nexforce/smart-route`. The model id
`nexforce/smart-route` routes dynamically; model limits then follow the model
the router actually serves for that request.
</Note>

## Cost control and transparency

Fallback chains, rate limits, and spend caps are configured per API key on the
Nexforce side. On the Nexforce side, every response discloses which model
actually served the request via the `X-Nexforce-Requested-Model` /
`X-Nexforce-Served-Model` response headers. Those headers are provider-side
metadata; inspect them at your HTTP layer if you want to audit the served model
and associated cost.

## Config example

```json5
{
  env: { NEXFORCE_API_KEY: "nfc_..." },
  agents: {
    defaults: {
      model: { primary: "nexforce/smart-route" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
