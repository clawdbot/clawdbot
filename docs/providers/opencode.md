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

Both catalogs share one OpenCode API key (`OPENCODE_API_KEY`, alias
`OPENCODE_ZEN_API_KEY`). OpenClaw keeps the runtime provider ids split so
upstream per-model routing stays correct, but onboarding and docs treat them as
one OpenCode setup.

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
        openclaw config set agents.defaults.model.primary "opencode/claude-opus-4-6"
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
    **Best for:** the OpenCode-hosted Kimi, GLM, MiniMax, Qwen, and DeepSeek lineup.

    <Steps>
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
</Tabs>

## Config example

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## Built-in catalogs

### Zen

| Property         | Value                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Runtime provider | `opencode`                                                                                    |
| Example models   | `opencode/claude-opus-4-6`, `opencode/gpt-5.5`, `opencode/gemini-3.1-pro`, `opencode/glm-5.2` |

Run `openclaw models list --provider opencode` for the full current list, which
also includes free-tier rows such as `opencode/big-pickle` and
`opencode/deepseek-v4-flash-free`.

### Go

| Property         | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Runtime provider | `opencode-go`                                                            |
| Example models   | `opencode-go/kimi-k2.6`, `opencode-go/glm-5`, `opencode-go/minimax-m2.5` |

See [OpenCode Go](/providers/opencode-go) for the full Go model table.

## Advanced configuration

<AccordionGroup>
  <Accordion title="API key aliases">
    `OPENCODE_ZEN_API_KEY` is also accepted as an alias for `OPENCODE_API_KEY`.
  </Accordion>

  <Accordion title="Shared credentials">
    Entering one OpenCode key during setup stores credentials for both runtime
    providers. You do not need to onboard each catalog separately.
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
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="OpenCode Go" href="/providers/opencode-go" icon="server">
    Full Go catalog reference.
  </Card>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
