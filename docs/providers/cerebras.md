---
summary: "Cerebras setup (auth + model selection)"
title: "Cerebras"
read_when:
  - You want to use Cerebras with OpenClaw
  - You need the Cerebras API key env var or CLI auth choice
---

[Cerebras](https://www.cerebras.ai) provides high-speed OpenAI-compatible inference on custom inference hardware. The plugin discovers native model metadata and pricing, with a bundled catalog for offline fallback.

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Provider id     | `cerebras`                                                |
| Plugin          | official external package (`@openclaw/cerebras-provider`) |
| Auth env var    | `CEREBRAS_API_KEY`                                        |
| Onboarding flag | `--auth-choice cerebras-api-key`                          |
| Direct CLI flag | `--cerebras-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                  |
| Base URL        | `https://api.cerebras.ai/v1`                              |
| Default model   | `cerebras/gemma-4-31b`                                    |

## Install plugin

```bash
openclaw plugins install @openclaw/cerebras-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get an API key">
    Create an API key in the [Cerebras Cloud Console](https://cloud.cerebras.ai).
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice cerebras-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk --skip-health \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```

```bash Env only
export CEREBRAS_API_KEY=csk-...
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider cerebras
    ```

    Lists the configured Cerebras models. If `CEREBRAS_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```

## Discovery and pricing

When Cerebras auth is configured and the inference base URL is the canonical
`https://api.cerebras.ai/v1`, OpenClaw reads
[`GET /public/v1/models`](https://inference-docs.cerebras.ai/api-reference/models/public-models).
This request uses public headers only: inference API keys and discovery
credentials are never sent to the metadata endpoint. A custom base URL skips
this public discovery rather than mixing a proxy's catalog with Cerebras metadata.
Without a Cerebras credential, the runtime provider stays inactive. Public
metadata listing does not establish account entitlement.

Live rows supply the native context and completion limits, reasoning and vision
capabilities, and prompt/completion prices. Cerebras returns those prices as USD
per-token strings; OpenClaw converts them to USD per million tokens. The public
feed does not provide cache tariffs. Zero cache fields in OpenClaw's runtime
estimate are not a claim about enterprise caching or billing.

Successful catalogs are cached for 60 seconds. If discovery fails, returns an
empty catalog, or has no usable model rows, OpenClaw uses the bundled offline
seed. In the default `models.mode: "merge"`, fresh onboarding does not copy
generated model rows or prices into your config, allowing prices to refresh.
Explicitly authored model rows and costs remain intact. In
`models.mode: "replace"`, discovery is disabled and onboarding keeps the offline
seed as explicit config instead.

## Built-in catalog

The three offline fallback models have a 131,072-token context window and a
40,960-token max output. Prices for models still present in the native
[public feed](https://api.cerebras.ai/public/v1/models) were refreshed from its
August 31, 2026 response; absent legacy references retain their seed snapshots.

| Model ref               | Name         | Reasoning | Notes                                                     |
| ----------------------- | ------------ | --------- | --------------------------------------------------------- |
| `cerebras/zai-glm-4.7`  | Z.ai GLM 4.7 | yes       | Deprecated August 17, 2026; retained for explicit configs |
| `cerebras/gpt-oss-120b` | GPT OSS 120B | yes       | Production reasoning model                                |
| `cerebras/gemma-4-31b`  | Gemma 4 31B  | yes       | Default; preview; text-and-image input                    |

Cerebras's [deprecation notice](https://inference-docs.cerebras.ai/support/deprecation)
marks `zai-glm-4.7` deprecated without naming a replacement. OpenClaw keeps the
shipped reference rather than deleting it or rewriting existing selections;
retention does not guarantee upstream availability.

Fresh onboarding follows Cerebras's current [Gemma 4 recommendation](https://www.cerebras.ai/blog/gemma-4-on-cerebras-the-fastest-inference-is-now-multimodal). Cerebras describes Gemma 4 31B as its reference medium-size model for equal-or-higher intelligence than GPT OSS, with multimodal agentic support. It is a public-preview model and may change or be discontinued on shorter notice than the production GPT OSS endpoint; existing OpenClaw configurations keep their selected model.

## Manual config

Most setups only need the API key. Use explicit `models.providers.cerebras` config to override model metadata in `mode: "merge"`; leave `models` empty to use discovered rows without pinning generated prices:

```json5
{
  env: { vars: { CEREBRAS_API_KEY: "csk-..." } },
  agents: {
    defaults: {
      model: { primary: "cerebras/gemma-4-31b" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [],
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure `CEREBRAS_API_KEY` is available to that process — for example in `~/.openclaw/.env` or through `env.shellEnv`. A key exported only in an interactive shell will not help a managed service unless the env is imported separately.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for the Cerebras models.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
</CardGroup>
