---
summary: "Meta setup, authentication, and Muse Spark model selection"
title: "Meta"
read_when:
  - You want to use Meta with OpenClaw
  - You need the MODEL_API_KEY env var or CLI auth choice
---

The **Meta API** uses the OpenAI-compatible **Responses API** (`POST /v1/responses`)
for the Muse Spark reasoning models. OpenClaw provides Meta as an official external
plugin.

| Property                   | Value                              |
| -------------------------- | ---------------------------------- |
| Provider id                | `meta`                             |
| Plugin                     | `@openclaw/meta-provider`          |
| Auth env var               | `MODEL_API_KEY`                    |
| Onboarding flag            | `--auth-choice meta-api-key`       |
| Direct CLI flag            | `--meta-api-key <key>`             |
| API                        | Responses API (`openai-responses`) |
| Base URL                   | `https://api.meta.ai/v1`           |
| Default model              | `meta/muse-spark-1.1`              |
| OpenClaw reasoning default | `high` (`reasoning.effort`)        |

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/meta-provider
    openclaw gateway restart
    ```
  </Step>
  <Step title="Set the API key">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice meta-api-key
```

```bash Direct flag
openclaw onboard --non-interactive --accept-risk \
  --auth-choice meta-api-key \
  --meta-api-key "$MODEL_API_KEY"
```

```bash Env only
export MODEL_API_KEY=<key>
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider meta
    ```

    Lists the static Muse Spark catalog entries. If `MODEL_API_KEY` is unresolved,
    `openclaw models status --json` reports the missing credential under
    `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice meta-api-key \
  --meta-api-key "$MODEL_API_KEY"
```

## Built-in catalog

Prices and data-use terms come from Meta's
[pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits/)
documentation.

| Model ref                         | Name                       | OpenClaw input | Reasoning | Context window | Input / cached input / output per 1M tokens |
| --------------------------------- | -------------------------- | -------------- | --------- | -------------- | ------------------------------------------- |
| `meta/muse-spark-1.1`             | Muse Spark 1.1             | text, image    | yes       | 1M             | $1.25 / $0.15 / $4.25                       |
| `meta/muse-spark-1.2`             | Muse Spark 1.2             | text, image    | yes       | 1M             | $1.25 / $0.15 / $4.25                       |
| `meta/muse-spark-1.2-contributor` | Muse Spark 1.2 Contributor | text, image    | yes       | 1M             | $0.10 / $0.002 / $0.20                      |

<Warning>
Official Meta language:

- Contributor tier: “Heavily discounted token pricing in exchange for permission to
  use your prompts and completions to train future Meta models.”
- Standard: “Not used to improve our products.”
- Contributor: “Used to improve our products.”
- Availability: “Available in select countries.”

Sources: [pricing documentation](https://dev.meta.ai/docs/pricing-rate-limits/),
[Muse Spark 1.2](https://developer.meta.com/ai/models/muse-spark/), and
[Muse Code announcement](https://developer.meta.com/ai/resources/blog/build-with-muse-code/).
</Warning>

Capabilities:

- Text and image input through OpenClaw
- Tool calling and streaming
- Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh` (OpenClaw default: `high`)
- Stateless encrypted reasoning replay (`store: false`, `include: ["reasoning.encrypted_content"]`)

The OpenClaw plugin currently sends text and image input. Meta's public
[Muse Spark 1.2 page](https://developer.meta.com/ai/models/muse-spark/) does not
currently enumerate the model's input modalities, so this table describes OpenClaw's
implemented transport rather than an exhaustive upstream capability list.

OpenClaw explicitly selects `high` when no thinking level is configured. This is an
OpenClaw default, not Meta's omitted-parameter behavior: Meta's
[reasoning documentation](https://dev.meta.ai/docs/features/reasoning/) says that when
`reasoning.effort` is omitted, the model reasons at a model-determined level.

<Warning>
Muse Spark does not accept `reasoning.effort: "none"`. OpenClaw maps
`--thinking off` to `minimal` for this provider.
</Warning>

## Manual config

```json5
{
  env: { vars: { MODEL_API_KEY: "<key>" } },
  agents: {
    defaults: {
      model: { primary: "meta/muse-spark-1.1" },
      models: {
        "meta/muse-spark-1.1": { alias: "Muse Spark 1.1" },
      },
    },
  },
}
```

<Note>
If the Gateway runs as a daemon (launchd, systemd, Docker), make sure
`MODEL_API_KEY` is available to that process — for example in
`~/.openclaw/.env` or through `env.shellEnv`. A key exported only in an
interactive shell will not help a managed service unless the env is imported
separately.
</Note>

## Smoke test

```bash
export MODEL_API_KEY=<key>
pnpm test:live -- extensions/meta/meta.live.test.ts
```

The standard live tests exercise `muse-spark-1.1` and `muse-spark-1.2` against
`POST /v1/responses`. Contributor testing is separately opt-in because of its data-use
terms:

```bash
export OPENCLAW_LIVE_META_CONTRIBUTOR=1
pnpm test:live -- extensions/meta/meta.live.test.ts
```

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for Muse Spark.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
</CardGroup>
