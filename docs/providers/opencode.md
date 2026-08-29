---
summary: "Use OpenCode Zen and Go catalogs with OpenClaw"
read_when:
  - You want OpenCode-hosted model access
  - You want to pick between the Zen and Go catalogs
title: "OpenCode"
---

OpenCode exposes two hosted catalogs in OpenClaw:

| Catalog | Prefix            | Runtime provider |
| ------- | ----------------- | ---------------- |
| **Zen** | `opencode/...`    | `opencode`       |
| **Go**  | `opencode-go/...` | `opencode-go`    |

Both catalogs use the same OpenCode API key infrastructure (`OPENCODE_API_KEY`,
alias `OPENCODE_ZEN_API_KEY`). Go still requires its own paid subscription;
having a Zen key does not by itself grant Go access. OpenClaw keeps the runtime
provider ids split so upstream per-model routing stays correct.

## Getting started

<Tabs>
  <Tab title="Zen catalog">
    **Best for:** the curated OpenCode multi-model proxy (Claude, GPT, Gemini, GLM,
    DeepSeek, Kimi, MiniMax, Qwen).

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-zen
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
        ```
      </Step>
      <Step title="Set a Zen model as the default">
        ```bash
        openclaw config set agents.defaults.model.primary "opencode/gpt-5.6-sol"
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider opencode
        ```
      </Step>
    </Steps>

  </Tab>

  <Tab title="Go catalog">
    **Best for:** the separately subscribed Go lineup across DeepSeek, GLM, GPT,
    Grok, Hy3, Kimi, MiMo, MiniMax, and Qwen.

    <Steps>
      <Step title="Use the bundled Go catalog">
        OpenCode Go is included with OpenClaw for this release, so no separate
        plugin installation or Gateway restart is required.
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice opencode-go
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
        ```
      </Step>
      <Step title="Set a Go model as the default">
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
</Tabs>

## Config example

```json5
{
  env: { vars: { OPENCODE_API_KEY: "sk-..." } },
  agents: { defaults: { model: { primary: "opencode/gpt-5.6-sol" } } },
}
```

## Provider catalogs

### Zen

| Property         | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Runtime provider | `opencode`                                                               |
| Example models   | `opencode/gpt-5.6-sol`, `opencode/kimi-k3`, `opencode/deepseek-v4-flash` |

Run `openclaw models list --provider opencode` for the current active list.
Model availability and promotional routes can change independently of OpenClaw.

Live discovery combines the models available to your OpenCode account with
authoritative model metadata from `https://models.opencode.ai/api.json`.
OpenClaw fetches and caches that catalog only when OpenCode Zen or Go is
configured or explicitly selected with OpenCode credentials; startup and
unrelated providers never download it. New upstream models become available
without an OpenClaw update when their metadata describes a supported transport
on the trusted OpenCode endpoint. A key-scoped response can omit models
unavailable to that workspace. Metadata and lifecycle status refresh together;
deprecated models are excluded from active discovery and its offline fallback.
Deprecated explicit refs remain resolvable for existing configurations but are
not shown as current recommendations.

### Go

| Property         | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Runtime provider | `opencode-go`                                                                     |
| Example models   | `opencode-go/kimi-k3`, `opencode-go/deepseek-v4-flash`, `opencode-go/qwen3.8-max` |

See [OpenCode Go](/providers/opencode-go) for discovery, routing, and access
requirements. Go's model-list endpoint advertises its general lineup; listing
a model does not prove your account can run it.

## Advanced configuration

<AccordionGroup>
  <Accordion title="API key aliases">
    `OPENCODE_ZEN_API_KEY` is also accepted as an alias for `OPENCODE_API_KEY`.
  </Accordion>

  <Accordion title="Shared credentials">
    Entering one OpenCode key during setup can store credentials for both
    runtime providers. It does not create a Go subscription or grant Go
    entitlement; subscribe to Go in the OpenCode console before using it.
  </Accordion>

  <Accordion title="Getting an API key">
    Create an OpenCode account and generate an API key at
    [opencode.ai/auth](https://opencode.ai/auth). Billing and catalog
    availability are managed from the OpenCode dashboard.
  </Accordion>

  <Accordion title="Gemini replay behavior">
    Gemini-backed OpenCode refs stay on the proxy-Gemini path, so OpenClaw keeps
    Gemini thought-signature sanitation there without enabling native Gemini
    replay validation or bootstrap rewrites.
  </Accordion>

  <Accordion title="Non-Gemini replay behavior">
    Non-Gemini OpenCode refs keep the minimal OpenAI-compatible replay policy.
  </Accordion>
  <Accordion title="Pricing and privacy">
    Billing, retention, and training policies are model-specific. Check the
    current [OpenCode Zen pricing and policy](https://opencode.ai/docs/zen/)
    before selecting a route. Free models may be temporary feedback programs.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="OpenCode Go" href="/providers/opencode-go" icon="server">
    Go catalog discovery and access requirements.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
