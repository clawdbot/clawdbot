---
summary: "Volcano Engine setup (Doubao models, general + coding endpoints)"
title: "Volcengine (Doubao)"
read_when:
  - You want to use Volcano Engine or Doubao models with OpenClaw
  - You need the Volcengine API key setup
---

The Volcengine provider gives access to Doubao models and third-party models
hosted on Volcano Engine, with separate endpoints for general and coding
workloads.

| Detail    | Value                                               |
| --------- | --------------------------------------------------- |
| Providers | `volcengine` (general) + `volcengine-plan` (coding) |
| Auth      | `VOLCANO_ENGINE_API_KEY`                            |
| API       | OpenAI-compatible                                   |

## Getting started

<Steps>
  <Step title="Set the API key">
    Run interactive onboarding:

    ```bash
    openclaw onboard --auth-choice volcengine-api-key
    ```

    This registers both the general (`volcengine`) and coding (`volcengine-plan`) providers from a single API key.

  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "volcengine-plan/ark-code-latest" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider volcengine
    openclaw models list --provider volcengine-plan
    ```
  </Step>
</Steps>

<Tip>
For non-interactive setup (CI, scripting), pass the key directly:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice volcengine-api-key \
  --volcengine-api-key "$VOLCANO_ENGINE_API_KEY"
```

</Tip>

## Providers and endpoints

| Provider          | Endpoint                                  | Use case       |
| ----------------- | ----------------------------------------- | -------------- |
| `volcengine`      | `ark.cn-beijing.volces.com/api/v3`        | General models |
| `volcengine-plan` | `ark.cn-beijing.volces.com/api/coding/v3` | Coding models  |

<Note>
Both providers are configured from a single API key. Setup registers both automatically.
</Note>

## Available models

<Tabs>
  <Tab title="General (volcengine)">
    | Model ref                                    | Name                            | Input       | Context |
    | -------------------------------------------- | ------------------------------- | ----------- | ------- |
    | `volcengine/doubao-seed-1-8-251228`          | Doubao Seed 1.8                 | text, image | 256,000 |
    | `volcengine/doubao-seed-code-preview-251028` | doubao-seed-code-preview-251028 | text, image | 256,000 |
    | `volcengine/kimi-k2-5-260127`                | Kimi K2.5                       | text, image | 256,000 |
    | `volcengine/glm-4-7-251222`                  | GLM 4.7                         | text, image | 200,000 |
    | `volcengine/deepseek-v3-2-251201`            | DeepSeek V3.2                   | text, image | 128,000 |
  </Tab>
  <Tab title="Coding (volcengine-plan)">
    | Model ref                                         | Name                     | Input | Context |
    | ------------------------------------------------- | ------------------------ | ----- | ------- |
    | `volcengine-plan/ark-code-latest`                 | Ark Coding Plan          | text  | 256,000 |
    | `volcengine-plan/doubao-seed-code`                | Doubao Seed Code         | text  | 256,000 |
    | `volcengine-plan/glm-4.7`                         | GLM 4.7 Coding           | text  | 200,000 |
    | `volcengine-plan/kimi-k2-thinking`                | Kimi K2 Thinking         | text  | 256,000 |
    | `volcengine-plan/kimi-k2.5`                       | Kimi K2.5 Coding         | text  | 256,000 |
    | `volcengine-plan/doubao-seed-code-preview-251028` | Doubao Seed Code Preview | text  | 256,000 |
  </Tab>
</Tabs>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Default model after onboarding">
    `openclaw onboard --auth-choice volcengine-api-key` currently sets
    `volcengine-plan/ark-code-latest` as the default model while also registering
    the general `volcengine` catalog.
  </Accordion>

  <Accordion title="Model picker fallback behavior">
    During onboarding/configure model selection, the Volcengine auth choice prefers
    both `volcengine/*` and `volcengine-plan/*` rows. If those models are not
    loaded yet, OpenClaw falls back to the unfiltered catalog instead of showing an
    empty provider-scoped picker.
  </Accordion>

  <Accordion title="Environment variables for daemon processes">
    If the Gateway runs as a daemon (launchd/systemd), make sure
    `VOLCANO_ENGINE_API_KEY` is available to that process (for example, in
    `~/.openclaw/.env` or via `env.shellEnv`).
  </Accordion>
</AccordionGroup>

<Warning>
When running OpenClaw as a background service, environment variables set in your
interactive shell are not automatically inherited. See the daemon note above.
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
  <Card title="Troubleshooting" href="/help/troubleshooting" icon="wrench">
    Common issues and debugging steps.
  </Card>
  <Card title="FAQ" href="/help/faq" icon="circle-question">
    Frequently asked questions about OpenClaw setup.
  </Card>
</CardGroup>
