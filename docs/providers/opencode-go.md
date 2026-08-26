---
summary: "Use the OpenCode Go catalog with the shared OpenCode setup"
read_when:
  - You want the OpenCode Go catalog
  - You need the runtime model refs for Go-hosted models
title: "OpenCode Go"
---

OpenCode Go is a separate paid subscription inside [OpenCode](/providers/opencode).
It uses the same `OPENCODE_API_KEY` credential infrastructure as Zen, but a Zen
key does not automatically include Go entitlement. Go keeps its own runtime
provider id (`opencode-go`) so upstream per-model routing stays correct.
OpenCode Go is bundled in the OpenClaw package for this release, so onboarding
and configuration are sufficient; no separate plugin install is required.

| Property         | Value                                              |
| ---------------- | -------------------------------------------------- |
| Runtime provider | `opencode-go`                                      |
| Plugin           | Bundled (`opencode-go`)                            |
| Auth             | `OPENCODE_API_KEY` (alias: `OPENCODE_ZEN_API_KEY`) |
| Parent setup     | [OpenCode](/providers/opencode)                    |

## Getting started

OpenCode Go is already included with OpenClaw for this release. Continue with
interactive onboarding or pass the shared OpenCode API key directly.

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
        openclaw config set agents.defaults.model.primary "opencode-go/kimi-k3"
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
  env: { vars: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" } }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k3" } } },
}
```

## Catalog

Run `openclaw models list --provider opencode-go` for the current model list.
OpenClaw combines the models available to your Go account with authoritative
metadata from `https://models.opencode.ai/api.json`, so new upstream models
appear without an OpenClaw update. The upstream catalog is downloaded and
cached only when OpenCode Zen or Go is configured or explicitly selected with
OpenCode credentials; it is never fetched at startup or while using unrelated
providers.

Current active rows:

| Model ref                       | Context   | Max output | Inputs      | Transport |
| ------------------------------- | --------- | ---------- | ----------- | --------- |
| `opencode-go/deepseek-v4-flash` | 1M        | 384K       | Text        | Chat      |
| `opencode-go/deepseek-v4-pro`   | 1M        | 384K       | Text        | Chat      |
| `opencode-go/glm-5.1`           | 202,752   | 32,768     | Text        | Chat      |
| `opencode-go/glm-5.2`           | 1M        | 131,072    | Text        | Chat      |
| `opencode-go/gpt-5.6-luna`      | 1.05M     | 128,000    | Text, image | Responses |
| `opencode-go/grok-4.5`          | 500,000   | 500,000    | Text, image | Chat      |
| `opencode-go/hy3`               | 256,000   | 64,000     | Text        | Chat      |
| `opencode-go/kimi-k2.6`         | 262,144   | 65,536     | Text, image | Chat      |
| `opencode-go/kimi-k2.7-code`    | 262,144   | 262,144    | Text, image | Chat      |
| `opencode-go/kimi-k3`           | 1,048,576 | 131,072    | Text, image | Chat      |
| `opencode-go/mimo-v2.5`         | 1M        | 128,000    | Text, image | Chat      |
| `opencode-go/mimo-v2.5-pro`     | 1,048,576 | 128,000    | Text        | Chat      |
| `opencode-go/minimax-m2.7`      | 204,800   | 131,072    | Text        | Messages  |
| `opencode-go/minimax-m3`        | 1M        | 131,072    | Text, image | Messages  |
| `opencode-go/ox-alpha-free`     | 1M        | 131,072    | Text, image | Chat      |
| `opencode-go/qwen3.6-plus`      | 1M        | 65,536     | Text, image | Messages  |
| `opencode-go/qwen3.7-max`       | 1M        | 65,536     | Text        | Messages  |
| `opencode-go/qwen3.7-plus`      | 1M        | 65,536     | Text, image | Messages  |
| `opencode-go/qwen3.8-max`       | 1M        | 131,072    | Text, image | Messages  |

Current upstream preview models appear while available. Deprecated refs remain
resolvable only for existing explicit configurations and are not recommended.

Ox Alpha Free is free for a limited time, but accessing the Go catalog still
requires a paid OpenCode Go subscription.

## Privacy

OpenCode lists zero data retention and no model training for Ox Alpha Free.
Privacy policies vary by model: some routes retain data for up to 30 days, and
the Muse Spark 1.2 Contributor route permits model training. Review the current
[OpenCode Go privacy table](https://opencode.ai/docs/go/#privacy) before using a
model, because provider policy can change independently of OpenClaw.

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
    The same `OPENCODE_API_KEY` can authenticate both runtime providers, so
    setup may store both profiles. Go access still requires a separate paid
    subscription in the OpenCode console.
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
