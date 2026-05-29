---
summary: "Use Anthropic Claude via API keys or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
title: "Anthropic"
---

Anthropic builds the **Claude** model family. OpenClaw supports two auth routes:

- **API key** — direct Anthropic API access with usage-based billing (`anthropic/*` models)
- **Claude CLI** — reuse an existing Claude Code login on the same host

<Warning>
OpenClaw's Claude CLI backend runs the installed Claude Code CLI in
non-interactive print mode. Anthropic's current Claude Code docs describe
`claude -p` as Agent SDK/programmatic usage. Starting June 15, 2026, Anthropic
says subscription-plan `claude -p` usage no longer draws from normal Claude
plan limits; it draws from a separate monthly Agent SDK credit first, then from
usage credits at standard API rates when those credits are enabled.

Interactive Claude Code still draws from the signed-in Claude plan limits. API
key auth remains direct pay-as-you-go API billing. For long-lived gateway hosts,
shared automation, and predictable production spend, use an Anthropic API key.

Anthropic's current public docs:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [Use Claude Code with your Team or Enterprise plan](https://support.claude.com/en/articles/11845131-using-claude-code-with-your-team-or-enterprise-plan)
- [Manage Claude Code costs](https://code.claude.com/docs/en/costs)

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
      env: { ANTHROPIC_API_KEY: "example-anthropic-key-not-real" },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
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

    <Warning>
    Claude CLI reuse expects the OpenClaw process to run on the same host as the
    Claude CLI login. Container installs such as [Podman](/install/podman) do
    not mount host `~/.claude` into setup or runtime; use an Anthropic API key
    there, or choose a provider with OpenClaw-managed OAuth such as
    [OpenAI Codex](/providers/openai).
    </Warning>

    ### Config example

    Prefer the canonical Anthropic model ref plus a CLI runtime override:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: {
            "anthropic/claude-opus-4-8": {
              agentRuntime: { id: "claude-cli" },
            },
          },
        },
      },
    }
    ```

    Legacy `claude-cli/claude-opus-4-7` model refs still work for
    compatibility, but new config should keep provider/model selection as
    `anthropic/*` and put the execution backend in provider/model runtime policy.

    ### Billing and `claude -p`

    OpenClaw uses Claude Code's non-interactive `claude -p` path for Claude CLI
    runs. Anthropic currently treats that path as Agent SDK/programmatic usage:

    - Until June 15, 2026, subscription-plan handling follows Anthropic's active
      Claude Code rules for the signed-in account.
    - Starting June 15, 2026, subscription-plan `claude -p` usage draws from the
      user's monthly Agent SDK credit first, then from usage credits at standard
      API rates if usage credits are enabled.
    - Console/API-key logins use pay-as-you-go API billing and do not receive
      the subscription Agent SDK credit.

    Anthropic can change Claude Code billing and rate-limit behavior without an
    OpenClaw release. Check `claude auth status`, `/status`, and
    Anthropic's linked docs when billing predictability matters.

    <Tip>
    For shared production automation, use an Anthropic API key instead of
    Claude CLI. OpenClaw also supports subscription-style options from
    [OpenAI Codex](/providers/openai), [Qwen Cloud](/providers/qwen),
    [MiniMax](/providers/minimax), and [Z.AI / GLM](/providers/zai).
    </Tip>

  </Tab>
</Tabs>

## Thinking defaults (Claude 4.8 and 4.6)

Claude Opus 4.8 keeps thinking off by default in OpenClaw. When you explicitly enable adaptive thinking with `/think high|xhigh|max`, OpenClaw sends Anthropic's Opus 4.8 effort values; Claude 4.6 models default to `adaptive`.

Override per-message with `/think:<level>` or in model params:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-8": {
          params: { thinking: "high" },
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

    | Property        | Value                 |
    | --------------- | --------------------- |
    | Default model   | `claude-opus-4-8`     |
    | Supported input | Images, PDF documents |

    When an image or PDF is attached to a conversation, OpenClaw automatically
    routes it through the Anthropic media understanding provider.

  </Accordion>

  <Accordion title="1M context window">
    Anthropic's 1M context window is available on GA-capable Claude 4.x models
    such as Opus 4.8, Opus 4.7, Opus 4.6, and Sonnet 4.6. OpenClaw sizes those models at
    1M automatically:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
    }
    ```

    Older configs can keep `params.context1m: true`, but OpenClaw no longer sends
    the retired `context-1m-2025-08-07` beta header. Older `anthropicBeta` config
    entries with that value are ignored during request header resolution and
    unsupported older Claude models stay on their normal context window.

    `params.context1m: true` also applies to the Claude CLI backend
    (`claude-cli/*`) for eligible GA-capable Opus and Sonnet models, preserving
    the runtime context window for those CLI sessions to match the direct-API
    behavior.

    <Warning>
    Requires long-context access on your Anthropic credential. OAuth/subscription token auth keeps its required Anthropic beta headers, but OpenClaw strips the retired 1M beta header if it remains in older config.
    </Warning>

  </Accordion>

  <Accordion title="Claude Opus 4.8 1M context">
    `anthropic/claude-opus-4-8` and its `claude-cli` variant have a 1M context
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
