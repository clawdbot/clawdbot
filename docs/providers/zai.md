---
summary: "Use Z.AI (GLM models) with OpenClaw"
read_when:
  - You want Z.AI / GLM models in OpenClaw
  - You need a simple ZAI_API_KEY setup
title: "Z.AI"
---

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and
uses API keys for authentication. Create your API key in the Z.AI console.
OpenClaw uses the `zai` provider with a Z.AI API key.

| Property | Value                                        |
| -------- | -------------------------------------------- |
| Provider | `zai`                                        |
| Auth     | `ZAI_API_KEY` (legacy alias: `Z_AI_API_KEY`) |
| API      | Z.AI Chat Completions (Bearer auth)          |

## GLM models

GLM is a model family, not a separate provider. In OpenClaw, GLM models use
refs such as `zai/glm-5.1`: provider `zai`, model id `glm-5.1`.

## Getting started

<Tabs>
  <Tab title="Auto-detect endpoint">
    **Best for:** most users. OpenClaw probes supported Z.AI endpoints with your API key and applies the correct base URL automatically.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice zai-api-key
        ```
      </Step>
      <Step title="Verify the model is listed">
        ```bash
        openclaw models list --all --provider zai
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Explicit regional endpoint">
    **Best for:** users who want to force a specific Coding Plan or general API surface.

    <Steps>
      <Step title="Pick the right onboarding choice">
        ```bash
        # Coding Plan Global (recommended for Coding Plan users)
        openclaw onboard --auth-choice zai-coding-global

        # Coding Plan CN (China region)
        openclaw onboard --auth-choice zai-coding-cn

        # General API
        openclaw onboard --auth-choice zai-global

        # General API CN (China region)
        openclaw onboard --auth-choice zai-cn
        ```
      </Step>
      <Step title="Verify the model is listed">
        ```bash
        openclaw models list --all --provider zai
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Config example

<Tip>
`zai-api-key` lets OpenClaw detect the matching Z.AI endpoint from the key and
apply the correct base URL automatically. Use the explicit regional choices when
you want to force a specific Coding Plan or general API surface.
</Tip>

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  models: {
    providers: {
      zai: {
        // Example value. Onboarding writes the matching baseUrl for your endpoint.
        baseUrl: "https://api.z.ai/api/paas/v4",
      },
    },
  },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

## Built-in catalog

OpenClaw ships the bundled `zai` provider catalog in the plugin manifest, so read-only
listing can show known GLM rows without loading provider runtime:

```bash
openclaw models list --all --provider zai
```

The manifest-backed catalog currently includes:

| Model ref            | Notes         |
| -------------------- | ------------- |
| `zai/glm-5.1`        | Default model |
| `zai/glm-5`          |               |
| `zai/glm-5-turbo`    |               |
| `zai/glm-5v-turbo`   |               |
| `zai/glm-4.7`        |               |
| `zai/glm-4.7-flash`  |               |
| `zai/glm-4.7-flashx` |               |
| `zai/glm-4.6`        |               |
| `zai/glm-4.6v`       |               |
| `zai/glm-4.5`        |               |
| `zai/glm-4.5-air`    |               |
| `zai/glm-4.5-flash`  |               |
| `zai/glm-4.5v`       |               |

<Tip>
GLM models are available as `zai/<model>` (example: `zai/glm-5`).
</Tip>

<Note>
The default bundled model ref is `zai/glm-5.1`. GLM versions and availability
can change; run `openclaw models list --all --provider zai` to see the catalog
known to your installed version.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Forward-resolving unknown GLM-5 models">
    Unknown `glm-5*` ids still forward-resolve on the bundled provider path by
    synthesizing provider-owned metadata from the `glm-4.7` template when the id
    matches the current GLM-5 family shape.
  </Accordion>

  <Accordion title="Tool-call streaming">
    `tool_stream` is enabled by default for Z.AI tool-call streaming. To disable it:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/<model>": {
              params: { tool_stream: false },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Thinking and preserved thinking">
    Z.AI thinking follows OpenClaw's `/think` controls. With thinking off,
    OpenClaw sends `thinking: { type: "disabled" }` to avoid responses that
    spend the output budget on `reasoning_content` before visible text.

    Preserved thinking is opt-in because Z.AI requires the full historical
    `reasoning_content` to be replayed, which increases prompt tokens. Enable it
    per model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "zai/glm-5.1": {
              params: { preserveThinking: true },
            },
          },
        },
      },
    }
    ```

    When enabled and thinking is on, OpenClaw sends
    `thinking: { type: "enabled", clear_thinking: false }` and replays prior
    `reasoning_content` for the same OpenAI-compatible transcript.

    Advanced users can still override the exact provider payload with
    `params.extra_body.thinking`.

  </Accordion>

  <Accordion title="Image understanding">
    The bundled Z.AI plugin registers image understanding.

    | Property      | Value       |
    | ------------- | ----------- |
    | Model         | `glm-4.6v`  |

    Image understanding is auto-resolved from the configured Z.AI auth — no
    additional config is needed.

  </Accordion>

  <Accordion title="Auth details">
    - Z.AI uses Bearer auth with your API key.
    - The `zai-api-key` onboarding choice auto-detects the matching Z.AI endpoint by probing supported endpoints with your key.
    - Use the explicit regional choices (`zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`) when you want to force a specific API surface.
    - The legacy env var `Z_AI_API_KEY` is still accepted; OpenClaw copies it to `ZAI_API_KEY` at startup if `ZAI_API_KEY` is unset.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw config schema, including provider and model settings.
  </Card>
</CardGroup>
