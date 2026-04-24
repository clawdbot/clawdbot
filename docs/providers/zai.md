---
summary: "Use Z.AI (GLM models) with OpenClaw"
read_when:
  - You want Z.AI / GLM models in OpenClaw
  - You need a simple ZAI_API_KEY setup
title: "Z.AI"
---

Z.AI is the API platform for **GLM** models. It provides REST APIs for GLM and uses API keys
for authentication. Create your API key in the Z.AI console. OpenClaw uses the `zai` provider
with a Z.AI API key.

- Provider: `zai`
- Auth: `ZAI_API_KEY`
- API: Z.AI Chat Completions (Bearer auth)

## Getting started

<Tabs>
  <Tab title="Auto-detect endpoint">
    **Best for:** most users. OpenClaw detects the matching Z.AI endpoint from the key and applies the correct base URL automatically.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice zai-api-key
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider zai
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
      <Step title="Set a default model">
        ```json5
        {
          env: { ZAI_API_KEY: "sk-..." },
          agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider zai
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Built-in catalog

OpenClaw currently seeds the bundled `zai` provider with:

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
GLM models are available as `zai/<model>` (example: `zai/glm-5`). The default bundled model ref is `zai/glm-5.1`.
</Tip>

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
    - The `zai-api-key` onboarding choice auto-detects the matching Z.AI endpoint from the key prefix.
    - Use the explicit regional choices (`zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`) when you want to force a specific API surface.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="GLM model family" href="/providers/glm" icon="microchip">
    Model family overview for GLM.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
