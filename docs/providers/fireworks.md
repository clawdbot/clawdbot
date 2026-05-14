---
summary: "Fireworks setup (auth + model selection)"
title: "Fireworks"
read_when:
  - You want to use Fireworks with OpenClaw
  - You need the Fireworks API key env var or default model id
  - You are debugging Kimi thinking-off behavior on Fireworks
---

[Fireworks](https://fireworks.ai) exposes open-weight and routed models through an OpenAI-compatible API. OpenClaw includes a bundled Fireworks provider plugin that ships with two pre-cataloged Kimi models and accepts any Fireworks model or router id at runtime.

| Property        | Value                                                  |
| --------------- | ------------------------------------------------------ |
| Provider id     | `fireworks` (alias: `fireworks-ai`)                    |
| Plugin          | bundled, `enabledByDefault: true`                      |
| Auth env var    | `FIREWORKS_API_KEY`                                    |
| Onboarding flag | `--auth-choice fireworks-api-key`                      |
| Direct CLI flag | `--fireworks-api-key <key>`                            |
| API             | OpenAI-compatible (`openai-completions`)               |
| Base URL        | `https://api.fireworks.ai/inference/v1`                |
| Default model   | `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` |
| Default alias   | `Kimi K2.5 Turbo`                                      |

## Getting started

<Steps>
  <Step title="Set the Fireworks API key">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice fireworks-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY"
```

```bash Env only
export FIREWORKS_API_KEY=fw-...
```

    </CodeGroup>

    Onboarding stores the key against the `fireworks` provider in your auth profiles and sets the **Fire Pass** Kimi K2.5 Turbo router as the default model.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider fireworks
    ```

    The list should include `Kimi K2.6` and `Kimi K2.5 Turbo (Fire Pass)`. If `FIREWORKS_API_KEY` is unresolved, `openclaw models status --json` reports the missing credential under `auth.unusableProfiles`.

  </Step>
</Steps>

## Non-interactive setup

For scripted or CI installs, pass everything on the command line:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "$FIREWORKS_API_KEY" \
  --skip-health \
  --accept-risk
```

## Built-in catalog

| Model ref                                              | Name                        | Input        | Context | Max output | Thinking             |
| ------------------------------------------------------ | --------------------------- | ------------ | ------- | ---------- | -------------------- |
| `fireworks/accounts/fireworks/models/kimi-k2p6`        | Kimi K2.6                   | text + image | 262,144 | 262,144    | Forced off           |
| `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` | Kimi K2.5 Turbo (Fire Pass) | text + image | 256,000 | 256,000    | Forced off (default) |

<Note>
  OpenClaw pins all Fireworks Kimi models to `thinking: off` because Fireworks rejects Kimi thinking parameters in production. Routing the same model through [Moonshot](/providers/moonshot) directly preserves Kimi reasoning output. See [thinking modes](/tools/thinking) for switching between providers.
</Note>

## Custom Fireworks model ids

OpenClaw accepts any Fireworks model or router id at runtime. Use the exact id shown by Fireworks and prefix it with `fireworks/`. Dynamic resolution clones the Fire Pass template (text + image input, OpenAI-compatible API, default cost zero) and disables thinking automatically when the id matches the Kimi pattern.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "fireworks/accounts/fireworks/models/<your-model-id>",
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

    OpenClaw strips the `fireworks/` prefix when constructing the API request and sends the remaining path to the Fireworks endpoint as the OpenAI-compatible `model` field.

  </Accordion>

  <Accordion title="Why thinking is forced off for Kimi">
    Fireworks K2.6 returns a 400 if the request carries `reasoning_*` parameters even though Kimi supports thinking through Moonshot's own API. The bundled policy (`extensions/fireworks/thinking-policy.ts`) advertises only the `off` thinking level for Kimi model ids, so manual `/think` switches and provider-policy surfaces stay aligned with the runtime contract.

    To use Kimi reasoning end-to-end, configure the [Moonshot provider](/providers/moonshot) and route the same model through it.

  </Accordion>

  <Accordion title="Environment availability for the daemon">
    If the Gateway runs as a managed service (launchd, systemd, Docker), the Fireworks key must be visible to that process — not just to your interactive shell.

    <Warning>
      A key exported only in an interactive shell will not help a launchd or systemd daemon unless that environment is imported there too. Set the key in `~/.openclaw/.env` or via `env.shellEnv` to make it readable from the gateway process.
    </Warning>

    On macOS, `openclaw gateway install` already wires `~/.openclaw/.env` into the LaunchAgent environment file. Re-run install (or `openclaw doctor --fix`) after rotating the key.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Thinking modes" href="/tools/thinking" icon="brain">
    `/think` levels, provider policies, and routing reasoning-capable models.
  </Card>
  <Card title="Moonshot" href="/providers/moonshot" icon="moon">
    Run Kimi with native thinking output through Moonshot's own API.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    General troubleshooting and FAQ.
  </Card>
</CardGroup>
