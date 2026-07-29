---
summary: "Use the OpenCode Go catalog with the shared OpenCode setup"
read_when:
  - You want the OpenCode Go catalog
  - You need the runtime model refs for Go-hosted models
title: "OpenCode Go"
---

OpenCode Go is the Go catalog inside [OpenCode](/providers/opencode). It shares
the `OPENCODE_API_KEY` credential with the Zen catalog, but keeps its own
runtime provider id (`opencode-go`) so upstream per-model routing stays
correct.

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| Runtime provider | `opencode-go`                                      |
| Auth             | `OPENCODE_API_KEY` (alias: `OPENCODE_ZEN_API_KEY`) |
| Parent setup     | [OpenCode](/providers/opencode)                    |

## Getting started

<Tabs>
  <Tab title="Interactive">
    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-go
        ```
      </Step>
      <Step title="Set a Go model as default">
        ```bash
        openclaw config set agents.defaults.model.primary "opencode-go/kimi-k2.6"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode-go
        ```
      </Step>
    </Steps>
  </Tab>

  <Tab title="Non-interactive">
    <Steps>
      <Step title="Pass the key directly">
        ```bash
        openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode-go
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

## Config example

```json5
{
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.6" } } },
}
```

## Built-in catalog

Run `openclaw models list --provider opencode-go` for the current model list.
Bundled rows:

| Model ref                       | Name              | Context   | Max output | Image input |
| ------------------------------- | ----------------- | --------- | ---------- | ----------- |
| `opencode-go/deepseek-v4-pro`   | DeepSeek V4 Pro   | 1M        | 384K       | No          |
| `opencode-go/deepseek-v4-flash` | DeepSeek V4 Flash | 1M        | 384K       | No          |
| `opencode-go/glm-5`             | GLM-5             | 202,752   | 32,768     | No          |
| `opencode-go/glm-5.1`           | GLM-5.1           | 202,752   | 32,768     | No          |
| `opencode-go/glm-5.2`           | GLM-5.2           | 1M        | 131,072    | No          |
| `opencode-go/hy3-preview`       | HY3 Preview       | 262,144   | 32,768     | No          |
| `opencode-go/kimi-k2.5`         | Kimi K2.5         | 262,144   | 65,536     | Yes         |
| `opencode-go/kimi-k2.6`         | Kimi K2.6         | 262,144   | 65,536     | Yes         |
| `opencode-go/kimi-k2.7-code`    | Kimi K2.7 Code    | 262,144   | 262,144    | Yes         |
| `opencode-go/mimo-v2.5`         | MiMo V2.5         | 1M        | 128,000    | Yes         |
| `opencode-go/mimo-v2.5-pro`     | MiMo V2.5 Pro     | 1,048,576 | 128,000    | No          |
| `opencode-go/minimax-m2.5`      | MiniMax M2.5      | 204,800   | 65,536     | No          |
| `opencode-go/minimax-m2.7`      | MiniMax M2.7      | 204,800   | 131,072    | No          |
| `opencode-go/minimax-m3`        | MiniMax M3        | 204,800   | 131,072    | No          |
| `opencode-go/qwen3.5-plus`      | Qwen3.5 Plus      | 262,144   | 65,536     | Yes         |
| `opencode-go/qwen3.6-plus`      | Qwen3.6 Plus      | 262,144   | 65,536     | Yes         |
| `opencode-go/qwen3.7-max`       | Qwen3.7 Max       | 1M        | 65,536     | No          |
| `opencode-go/qwen3.7-plus`      | Qwen3.7 Plus      | 1M        | 65,536     | Yes         |

## Advanced configuration

<AccordionGroup>
  <Accordion title="Routing behavior">
    OpenClaw routes any `opencode-go/...` model ref automatically. No extra
    provider config is required.
  </Accordion>

  <Accordion title="Runtime ref convention">
    Runtime refs stay explicit: `opencode/...` for Zen, `opencode-go/...` for
    Go. This keeps upstream per-model routing correct across both catalogs.
  </Accordion>

  <Accordion title="Shared credentials">
    One `OPENCODE_API_KEY` covers both the Zen and Go catalogs. Entering the
    key during setup stores credentials for both runtime providers.
  </Accordion>
</AccordionGroup>

<Tip>
See [OpenCode](/providers/opencode) for the shared onboarding overview and the full
Zen + Go catalog reference.
</Tip>

## Related

<CardGroup cols={2}>
  <Card title="OpenCode (parent)" href="/providers/opencode" icon="server">
    Shared onboarding, catalog overview, and advanced notes.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
</CardGroup>
