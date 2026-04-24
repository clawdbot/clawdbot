---
summary: "Use Anthropic Claude via API keys or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
title: "Anthropic"
---

# Anthropic (Claude)

Anthropic builds the **Claude** model family. OpenClaw supports two auth routes:

- **API key** — direct Anthropic API access with usage-based billing (`anthropic/*` models)
- **Claude CLI** — reuse an existing Claude CLI login on the same host

<Warning>
Anthropic staff told us OpenClaw-style Claude CLI usage is allowed again, so
OpenClaw treats Claude CLI reuse and `claude -p` usage as sanctioned unless
Anthropic publishes a new policy.

For long-lived gateway hosts, Anthropic API keys are still the clearest and
most predictable production path.

Anthropic's current public docs:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Using Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)
- [Using Claude Code with your Team or Enterprise plan](https://support.anthropic.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan/)

</Warning>

## Getting started

<Tabs>
  <Tab title="API key">
    **Best for:** standard API access and usage-based billing.

    <Steps>
      <Step title="Get your API key">
        Create an API key in the [Anthropic Console](https://console.anthropic.com/).
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        # choose: Anthropic API key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider anthropic
        ```
      </Step>
    </Steps>

    ### Config example

    ```json5
    {
      env: { ANTHROPIC_API_KEY: "sk-ant-..." },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
    }
    ```

  </Tab>

  <Tab title="Claude CLI">
    **Best for:** reusing an existing Claude CLI login without a separate API key.

    <Steps>
      <Step title="Ensure Claude CLI is installed and logged in">
        Verify with:

        ```bash
        claude --version
        ```
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        # choose: Claude CLI
        ```

        OpenClaw detects and reuses the existing Claude CLI credentials.
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider anthropic
        ```
      </Step>
    </Steps>

    <Note>
    Setup and runtime details for the Claude CLI backend are in [CLI Backends](/gateway/cli-backends).
    </Note>

    <Tip>
    If you want the clearest billing path, use an Anthropic API key instead. OpenClaw also supports subscription-style options from [OpenAI Codex](/providers/openai), [Qwen Cloud](/providers/qwen), [MiniMax](/providers/minimax), and [Z.AI / GLM](/providers/glm).
    </Tip>

  </Tab>
</Tabs>

## Thinking defaults (Claude 4.6)

Claude 4.6 models default to `adaptive` thinking in OpenClaw when no explicit thinking level is set.

Override per-message with `/think:<level>` or in model params:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { thinking: "adaptive" },
        },
      },
    },
  },
}
```

<Note>
Related Anthropic docs:
- [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
</Note>

## Prompt caching

OpenClaw supports Anthropic's prompt caching feature for API-key auth.

| Value               | Cache duration | Description                            |
| ------------------- | -------------- | -------------------------------------- |
| `"short"` (default) | 5 minutes      | Applied automatically for API-key auth |
| `"long"`            | 1 hour         | Extended cache                         |
| `"none"`            | No caching     | Disable prompt caching                 |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

<AccordionGroup>
  <Accordion title="Per-agent cache overrides">
    Use model-level params as your baseline, then override specific agents via `agents.list[].params`:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": {
              params: { cacheRetention: "long" },
            },
          },
        },
        list: [
          { id: "research", default: true },
          { id: "alerts", params: { cacheRetention: "none" } },
        ],
      },
    }
    ```

    Config merge order:

    1. `agents.defaults.models["provider/model"].params`
    2. `agents.list[].params` (matching `id`, overrides by key)

    This lets one agent keep a long-lived cache while another agent on the same model disables caching for bursty/low-reuse traffic.

  </Accordion>

  <Accordion title="Bedrock Claude notes">
    - Anthropic Claude models on Bedrock (`amazon-bedrock/*anthropic.claude*`) accept `cacheRetention` pass-through when configured.
    - Non-Anthropic Bedrock models are forced to `cacheRetention: "none"` at runtime.
    - API-key smart defaults also seed `cacheRetention: "short"` for Claude-on-Bedrock refs when no explicit value is set.
  </Accordion>
</AccordionGroup>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Fast mode">
    OpenClaw's shared `/fast` toggle supports direct Anthropic traffic (API-key and OAuth to `api.anthropic.com`).

    | Command | Maps to |
    |---------|---------|
    | `/fast on` | `service_tier: "auto"` |
    | `/fast off` | `service_tier: "standard_only"` |

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: { fastMode: true },
            },
          },
        },
      },
    }
    ```

    <Note>
    - Only injected for direct `api.anthropic.com` requests. Proxy routes leave `service_tier` untouched.
    - Explicit `serviceTier` or `service_tier` params override `/fast` when both are set.
    - On accounts without Priority Tier capacity, `service_tier: "auto"` may resolve to `standard`.
    </Note>

  </Accordion>

  <Accordion title="Media understanding (image and PDF)">
    The bundled Anthropic plugin registers image and PDF understanding. OpenClaw
    auto-resolves media capabilities from the configured Anthropic auth — no
    additional config is needed.

    | Property       | Value                |
    | -------------- | -------------------- |
    | Default model  | `claude-opus-4-6`    |
    | Supported input | Images, PDF documents |

    When an image or PDF is attached to a conversation, OpenClaw automatically
    routes it through the Anthropic media understanding provider.

  </Accordion>

  <Accordion title="1M context window (beta)">
    Anthropic's 1M context window is beta-gated. Enable it per model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {
              params: { context1m: true },
            },
          },
        },
      },
    }
    ```

    OpenClaw maps this to `anthropic-beta: context-1m-2025-08-07` on requests.

    <Warning>
    Requires long-context access on your Anthropic credential. Legacy token auth (`sk-ant-oat-*`) is rejected for 1M context requests — OpenClaw logs a warning and falls back to the standard context window.
    </Warning>

  </Accordion>

  <Accordion title="Claude Opus 4.7 1M context">
    `anthropic/claude-opus-4.7` and its `claude-cli` variant have a 1M context
    window by default — no `params.context1m: true` needed.
  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="401 errors / token suddenly invalid">
    Anthropic token auth expires and can be revoked. For new setups, use an Anthropic API key instead.
  </Accordion>

  <Accordion title='No API key found for provider "anthropic"'>
    Anthropic auth is **per agent** — new agents do not inherit the main agent's keys. Re-run onboarding for that agent (or configure an API key on the gateway host), then verify with `openclaw models status`.
  </Accordion>

  <Accordion title='No credentials found for profile "anthropic:default"'>
    Run `openclaw models status` to see which auth profile is active. Re-run onboarding, or configure an API key for that profile path.
  </Accordion>

  <Accordion title="No available auth profile (all in cooldown)">
    Check `openclaw models status --json` for `auth.unusableProfiles`. Anthropic rate-limit cooldowns can be model-scoped, so a sibling Anthropic model may still be usable. Add another Anthropic profile or wait for cooldown.
  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="CLI backends" href="/gateway/cli-backends" icon="terminal">
    Claude CLI backend setup and runtime details.
  </Card>
  <Card title="Prompt caching" href="/reference/prompt-caching" icon="database">
    How prompt caching works across providers.
  </Card>
  <Card title="OAuth and auth" href="/gateway/authentication" icon="key">
    Auth details and credential reuse rules.
  </Card>
</CardGroup>
