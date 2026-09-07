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
OpenClaw combines Go's advertised model IDs with authoritative metadata from
`https://models.opencode.ai/api.json`, so new upstream models appear without an
OpenClaw update when they use a supported transport on the trusted OpenCode
endpoint. The upstream catalog is downloaded and
cached only when OpenCode Zen or Go is configured or explicitly selected with
OpenCode credentials; it is never fetched at startup or while using unrelated
providers.

Example refs include `opencode-go/deepseek-v4-flash`, `opencode-go/kimi-k3`, and
`opencode-go/qwen3.8-max`. Use the CLI for the current lineup rather than treating
these examples as an inventory. OpenClaw excludes deprecated rows from active
discovery and applies refreshed lifecycle status to its offline fallback.
Bundled preview rows stay hidden until accepted upstream metadata supplies them.
Existing explicit refs in the bundled seed remain resolvable.

The Go model-list endpoint is a general inventory, not an account-entitlement
check. A successful listing does not grant access: inference still requires an
active Go subscription, including for promotional models.

## Privacy

Retention and training policies vary by model. Review the current
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
