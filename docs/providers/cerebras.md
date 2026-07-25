---
summary: "Cerebras setup (auth + model selection)"
title: "Cerebras"
read_when:
  - You want to use Cerebras with OpenClaw
  - You need the Cerebras API key env var or CLI auth choice
---

[Cerebras](https://www.cerebras.ai) provides high-speed OpenAI-compatible inference on custom inference hardware. The plugin ships a static two-model catalog (no live discovery).

| Property        | Value                                                     |
| --------------- | --------------------------------------------------------- |
| Provider id     | `cerebras`                                                |
| Plugin          | official external package (`@openclaw/cerebras-provider`) |
| Auth env var    | `CEREBRAS_API_KEY`                                        |
| Onboarding flag | `--auth-choice cerebras-api-key`                          |
| Direct CLI flag | `--cerebras-api-key <key>`                                |
| API             | OpenAI-compatible (`openai-completions`)                  |
| Base URL        | `https://api.cerebras.ai/v1`                              |
| Default model   | `cerebras/zai-glm-4.7`                                    |

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
openclaw onboard --non-interactive \
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

    Lists both static models. If `CEREBRAS_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice cerebras-api-key \
  --cerebras-api-key "$CEREBRAS_API_KEY"
```

## Built-in catalog

Both models share a 128k context window and 8,192 max output tokens.

| Model ref               | Name         | Reasoning | Notes                                  |
| ----------------------- | ------------ | --------- | -------------------------------------- |
| `cerebras/zai-glm-4.7`  | Z.ai GLM 4.7 | yes       | Default model; preview reasoning model |
| `cerebras/gpt-oss-120b` | GPT OSS 120B | yes       | Production reasoning model             |

## Manual config

Most setups only need the API key. Use explicit `models.providers.cerebras` config to override model metadata or run in `mode: "merge"` against the static catalog:

```json5
{
  env: { CEREBRAS_API_KEY: "csk-..." },
  agents: {
    defaults: {
      model: { primary: "cerebras/zai-glm-4.7" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "Z.ai GLM 4.7" },
          { id: "gpt-oss-120b", name: "GPT OSS 120B" },
        ],
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
    Reasoning effort levels for the two reasoning-capable Cerebras models.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
</CardGroup>
