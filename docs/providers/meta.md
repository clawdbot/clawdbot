---
summary: "Meta setup (auth + muse-spark-1.1 model selection)"
title: "Meta"
read_when:
  - You want to use Meta with OpenClaw
  - You need the MODEL_API_KEY env var or CLI auth choice
---

The **Meta API** uses the OpenAI-compatible **Responses API** (`POST /v1/responses`)
for the `muse-spark-1.1` reasoning model. The provider ships as a bundled OpenClaw
plugin.

| Property          | Value                              |
| ----------------- | ---------------------------------- |
| Provider id       | `meta`                             |
| Plugin            | bundled provider                   |
| Auth env var      | `MODEL_API_KEY`                    |
| Onboarding flag   | `--auth-choice meta-api-key`       |
| Direct CLI flag   | `--meta-api-key <key>`             |
| API               | Responses API (`openai-responses`) |
| Base URL          | `https://api.meta.ai/v1`           |
| Default model     | `meta/muse-spark-1.1`              |
| Default reasoning | `high` (`reasoning.effort`)        |

## Getting started

<Steps>
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

    Lists the static `muse-spark-1.1` catalog entry. If `MODEL_API_KEY` is unresolved,
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

| Model ref             | Name           | Reasoning | Context window | Max output |
| --------------------- | -------------- | --------- | -------------- | ---------- |
| `meta/muse-spark-1.1` | Muse Spark 1.1 | yes       | 1,048,576      | 131,072    |

Capabilities:

- Text + image input
- Tool calling and streaming
- Reasoning effort: `minimal`, `low`, `medium`, `high`, `xhigh` (default: `high`)
- Stateless encrypted reasoning replay (`store: false`, `include: ["reasoning.encrypted_content"]`)

<Warning>
`muse-spark-1.1` does not accept `reasoning.effort: "none"`. OpenClaw maps
`--thinking off` to `minimal` for this provider.
</Warning>

## Manual config

```json5
{
  env: { MODEL_API_KEY: "<key>" },
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

Live tests use `muse-spark-1.1` against `POST /v1/responses`.

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    Reasoning effort levels for muse-spark-1.1.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
</CardGroup>
