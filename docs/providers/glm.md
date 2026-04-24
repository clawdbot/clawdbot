---
summary: "GLM model family overview + how to use it in OpenClaw"
read_when:
  - You want GLM models in OpenClaw
  - You need the model naming convention and setup
title: "GLM (Zhipu)"
---

# GLM models

GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM
models are accessed via the `zai` provider and model IDs like `zai/glm-5`.

## Getting started

<Steps>
  <Step title="Choose an auth route and run onboarding">
    Pick the onboarding choice that matches your Z.AI plan and region:

    | Auth choice | Best for |
    | ----------- | -------- |
    | `zai-api-key` | Generic API-key setup with endpoint auto-detection |
    | `zai-coding-global` | Coding Plan users (global) |
    | `zai-coding-cn` | Coding Plan users (China region) |
    | `zai-global` | General API (global) |
    | `zai-cn` | General API (China region) |

    ```bash
    # Example: generic auto-detect
    openclaw onboard --auth-choice zai-api-key

    # Example: Coding Plan global
    openclaw onboard --auth-choice zai-coding-global
    ```

  </Step>
  <Step title="Set GLM as the default model">
    ```bash
    openclaw config set agents.defaults.model.primary "zai/glm-5.1"
    ```
  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider zai
    ```
  </Step>
</Steps>

## Config example

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5.1" } } },
}
```

<Tip>
`zai-api-key` lets OpenClaw detect the matching Z.AI endpoint from the key and
apply the correct base URL automatically. Use the explicit regional choices when
you want to force a specific Coding Plan or general API surface.
</Tip>

## Built-in catalog

OpenClaw currently seeds the bundled `zai` provider with these GLM refs:

| Model           | Model            |
| --------------- | ---------------- |
| `glm-5.1`       | `glm-4.7`        |
| `glm-5`         | `glm-4.7-flash`  |
| `glm-5-turbo`   | `glm-4.7-flashx` |
| `glm-5v-turbo`  | `glm-4.6`        |
| `glm-4.5`       | `glm-4.6v`       |
| `glm-4.5-air`   |                  |
| `glm-4.5-flash` |                  |
| `glm-4.5v`      |                  |

<Note>
The default bundled model ref is `zai/glm-5.1`. GLM versions and availability
can change; check Z.AI's docs for the latest.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Endpoint auto-detection">
    When you use the `zai-api-key` auth choice, OpenClaw inspects the key format
    to determine the correct Z.AI base URL. Explicit regional choices
    (`zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`) override
    auto-detection and pin the endpoint directly.
  </Accordion>

  <Accordion title="Provider details">
    GLM models are served by the `zai` runtime provider. For full provider
    configuration, regional endpoints, and additional capabilities, see
    [Z.AI provider docs](/providers/zai).
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Z.AI provider" href="/providers/zai" icon="server">
    Full Z.AI provider configuration and regional endpoints.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
