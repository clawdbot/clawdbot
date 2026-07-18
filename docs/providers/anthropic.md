---
summary: "Use Anthropic Claude via API keys or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want to browse Claude CLI or Claude Desktop sessions across paired computers
title: "Anthropic"
---

Anthropic builds the **Claude** model family. OpenClaw supports two auth routes:

- **API key** - direct Anthropic API access with usage-based billing (`anthropic/*` models)
- **Claude CLI** - reuse an existing Claude Code login on the same host

## Usage and cost tracking

OpenClaw detects the available Anthropic credential and selects the matching usage surface:

- Claude subscription/setup credentials show quota windows and optional extra-usage budget.
- `ANTHROPIC_ADMIN_KEY` or `ANTHROPIC_ADMIN_API_KEY` shows 30 days of provider-reported organization cost and Messages API usage in Control UI **Usage**, including daily spend, token/cache totals, top models, and cost categories.
- An `sk-ant-admin...` credential stored in the Anthropic provider profile is detected as an Admin API key automatically.

Admin API cost history comes from Anthropic's [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api). It is actual provider billing, separate from OpenClaw's session-derived estimated cost.

<Warning>
OpenClaw's Claude CLI backend runs the installed Claude Code CLI in
non-interactive print mode (`claude -p`). Anthropic's current Claude Code docs
describe that mode as Agent SDK/programmatic usage. Anthropic's June 15, 2026
support update paused the announced separate Agent SDK billing change: Claude
Agent SDK, `claude -p`, and third-party app usage still draw from a signed-in
subscription's usage limits, and the previously announced monthly Agent SDK
credit is not available while Anthropic revises that plan.

Interactive Claude Code still draws from the signed-in Claude plan's limits.
API key auth is direct pay-as-you-go billing and does not depend on that plan.
For long-lived gateway hosts, shared automation, and predictable production
spend, use an Anthropic API key.

Anthropic's current support articles can change this behavior without an
OpenClaw release:

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
    Claude CLI login. Docker installs can persist a container home and log in to
    Claude Code there; see
    [Claude CLI backend in Docker](/install/docker#claude-cli-backend-in-docker).
    Other container installs such as [Podman](/install/podman) do not mount host
    `~/.claude` into setup or runtime; use an Anthropic API key there, or choose
    a provider with OpenClaw-managed OAuth such as
    [OpenAI Codex](/providers/openai).
    </Warning>

    ### Get a setup token

    Run `claude setup-token` on any machine with Claude Code installed. It prints
    a long-lived token starting with `sk-ant-oat01-`.

    During onboarding, paste the token in the macOS app by choosing
    **Anthropic setup-token** under **Connect with an API key or token**, or use:

    ```bash
    openclaw models auth login --provider anthropic --method setup-token
    ```

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

    - Anthropic's June 15, 2026 support update paused the previously announced
      separate Agent SDK credit plan.
    - Subscription-plan Claude Agent SDK, `claude -p`, and third-party app usage
      still draw from the signed-in subscription's usage limits.
    - The previously announced monthly Agent SDK credit is not available while
      Anthropic revises that plan.
    - Console/API-key logins use pay-as-you-go API billing and do not receive
      the subscription Agent SDK credit.

    See Anthropic's [Agent SDK plan
    article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
    for the pause notice, and the Claude Code plan articles for
    [Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
    and
    [Team/Enterprise](https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan)
    subscription behavior.

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

## Claude sessions across computers

The bundled Anthropic plugin adds a **Claude Code** group to the normal sessions
sidebar. Rows open in the normal Chat pane. It discovers non-archived Claude
Code sessions on the Gateway and on connected node hosts:

- Claude CLI sessions come from valid project-index records and current JSONL
  files whose bounded metadata prefix identifies a non-sidechain `sdk-cli`
  session under `~/.claude/projects/`.
- Claude Desktop sessions use the Desktop title, activity time, and
  archive state when its metadata points to the same Claude Code session ID.
- A CLI-only session has no archive flag, so it remains visible while its
  transcript is present.

No additional OpenClaw config is required for discovery. The Anthropic plugin
is bundled and enabled by default; a native macOS node advertises the read-only
Claude session commands when the local `~/.claude/projects/` directory exists.
Approve the node pairing upgrade when those commands first appear.

The sidebar groups rows by their Gateway or paired-node host and shows each
host's newest bounded page as soon as that computer answers. It reconciles again
after host-connectivity changes, when the page regains focus, and at most every
30 seconds while visible, so Claude sessions created outside OpenClaw appear
without a reload. A changed catalog gets a faster follow-up pass. Use **Load more
sessions** below a catalog group to append the next page for every host that has
more history; appended rows stay visible and are re-fetched to the same depth
across refreshes. Catalog clients use `sessions.catalog.list`; opening a row uses
`sessions.catalog.read`.

Terminal takeover resolves `claude` from the owning host user's login-shell
PATH before the service/daemon PATH. This keeps app-launched sessions aligned
with the Claude CLI the operator gets in a normal terminal.

Selecting a row reads the newest transcript page first. **Load older transcript
items** follows an opaque byte cursor and reads another bounded section from the
JSONL file instead of loading the entire history. Normal user, assistant,
reasoning, tool-call, and tool-result content is preserved. An individual item
larger than the node/Gateway safety ceiling is clearly marked as truncated.

For a Gateway-local `claude-cli` row, typing in the normal composer calls
`sessions.catalog.continue`. OpenClaw re-resolves the local catalog record,
creates or reuses a model-locked native session, imports at most 200 visible
items or 512 KiB, and seeds the Claude CLI binding. The first turn resumes with
`--fork-session`; Claude assigns the fork a new session ID, so later turns use
the fork and the source session stays untouched.

A headless node host can also make its Claude CLI rows continuable by enabling
the node-local setting below and restarting the node host:

```json5
{
  nodeHost: {
    agentRuns: {
      claude: { enabled: true },
    },
  },
}
```

The node advertises `agent.cli.claude.run.v1` only when the setting is enabled
and its local `claude` executable resolves. OpenClaw re-resolves the catalog
record on that node, imports the same bounded history, and binds the adopted
session to the node and catalog-reported working directory. Each turn runs the
node's real `claude -p` process using that node's Claude files and login. The
node's exec approval policy still applies; the Gateway cannot force the opt-in.

Node continuation v1 is one-shot only. It omits Gateway loopback MCP config and
Gateway skills plugin arguments, does not reseed from a Gateway transcript, and
rejects attachments and images. Claude Desktop rows remain view-only. Native
macOS app nodes also remain view-only until the app advertises the run command.

<Note>
Paired-node Claude sessions remain read-only unless the headless node explicitly
advertises `agent.cli.claude.run.v1`. OpenClaw never modifies Claude Desktop
metadata or archives Claude sessions. The page requires an operator connection
with write scope because it uses authenticated `node.invoke`; list and read
remain read-only even on a continuation-enabled node.
</Note>

See [Nodes: Claude sessions and transcripts](/nodes#claude-sessions-and-transcripts)
for the node command and security boundary.

## Thinking defaults (Claude Sonnet 5, Mythos 5, Fable 5, 4.8, and 4.6)

`anthropic/claude-sonnet-5` uses adaptive thinking at `high` effort by default.
Use `/think off` to disable thinking, or `/think xhigh|max` for the model's
higher native effort levels. OpenClaw omits manual thinking budgets, custom
sampling parameters, assistant prefills, and Priority Tier for Sonnet 5 because
Anthropic does not support those request features on this model.
The catalog uses Anthropic's introductory `$2/$10` input/output pricing through
August 31, 2026; standard `$3/$15` pricing begins September 1, 2026.

`anthropic/claude-fable-5` always uses adaptive thinking and defaults to `high`
effort. Anthropic does not allow thinking to be disabled for this model, so
`/think off` and `/think minimal` map to `low` effort instead. OpenClaw also
omits custom temperature values for Fable 5 requests, since Anthropic rejects
a temperature override on any thinking-enabled request.

`anthropic/claude-mythos-5` is a limited-access model with the same always-on
adaptive-thinking contract. OpenClaw defaults to `high`, maps `/think off` and
`/think minimal` to `low`, and omits caller-selected sampling parameters.
The catalog publishes its 1,000,000-token context window, 128,000-token output
limit, image input, and `$10/$50` input/output pricing.

Claude Opus 4.8 keeps thinking off by default in OpenClaw. When you explicitly
enable adaptive thinking with `/think high|xhigh|max`, OpenClaw sends
Anthropic's Opus 4.8 effort values; Claude 4.6 models (Opus 4.6 and Sonnet 4.6)
default to `adaptive`.

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

## Safety refusal fallback (Claude Fable 5)

<Warning>
Using Claude Fable 5 means also using Claude Opus 4.8. Fable 5 ships with
safety classifiers that can decline a request, and Anthropic's sanctioned
recovery is to have `claude-opus-4-8` serve that turn. OpenClaw opts into this
automatically for direct API-key requests, so some Fable turns are answered
and billed as Claude Opus 4.8. If your policy or budget cannot accept
Opus-served turns, do not select `anthropic/claude-fable-5`.
</Warning>

### Why this exists

Fable 5 classifiers return `stop_reason: "refusal"` on requests in restricted
domains, and they also false-positive on benign-adjacent work (security
tooling, life sciences, or even asking the model to reproduce its raw
reasoning). Without a fallback, the turn dies with an error even though
another Claude model would happily serve it - Anthropic's own refusal message
tells API integrators to configure a fallback model.

### How it works

1. For every direct API-key request to `anthropic/claude-fable-5`, OpenClaw
   sends Anthropic's server-side fallback opt-in: the
   `server-side-fallback-2026-06-01` beta header plus
   `fallbacks: [{"model": "claude-opus-4-8"}]`. Claude Opus 4.8 is the only
   fallback target Anthropic permits for Fable 5.
2. Only a safety-classifier decline triggers the fallback. Rate limits,
   overloads, and server errors behave exactly as before and go through
   OpenClaw's normal [model failover](/concepts/model-failover).
3. The rescue happens inside the same call. A decline before any output is
   invisible apart from latency; the whole answer comes from Opus 4.8. On a
   mid-stream decline the partial text is kept as the prefix the fallback
   model continues from, while the declined model's reasoning and tool calls
   are discarded per Anthropic's replay rules (they must not be echoed back or
   executed).
4. If Claude Opus 4.8 declines as well, the turn surfaces the refusal as an
   error, exactly like before this feature.

The fallback happens at the Anthropic API level, so `claude-opus-4-8` does not
need to be in your configured model list or fallback chain - a Fable-capable
API key can always serve Opus.

### Observability and billing

- A fallback-served turn records a `provider_fallback` diagnostic on the
  assistant message naming `fromModel` and `toModel`, and the message's
  `responseModel` reports `claude-opus-4-8`.
- Anthropic bills per attempt: a decline before output is free, and the rescue
  bills at Claude Opus 4.8 rates (currently half of Fable 5 rates). OpenClaw's
  per-turn cost estimate prices fallback-served turns at Opus rates to match.
- A mid-stream decline additionally bills the already-streamed Fable partial
  on Anthropic's side; that portion is reported in the API's per-attempt
  usage but not folded into OpenClaw's per-turn estimate.

### Scope

Applies to `anthropic/claude-fable-5` with API-key auth against
`api.anthropic.com`. OAuth (Claude CLI subscription reuse), proxy base URLs,
Bedrock, Vertex, and Foundry requests are unchanged and still surface
refusals as errors there.

Verified live: a benign prompt asking Fable 5 to reproduce its raw chain of
thought is declined with `category: "reasoning_extraction"` when sent without
fallbacks, and the same prompt through OpenClaw returns a normal Opus-served
answer with the `provider_fallback` diagnostic attached.

See Anthropic's [refusals and fallback
guide](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)
for the underlying behavior.

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
    OpenClaw's shared `/fast` toggle sets Anthropic's `service_tier` field for direct API-key traffic to `api.anthropic.com`.

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
    - Only applies to direct `api.anthropic.com` requests made with an API key. OAuth/subscription-token requests and proxy routes never get a `service_tier` field.
    - Explicit `serviceTier` or `service_tier` params override `/fast` when both are set.
    - On accounts without Priority Tier capacity, `service_tier: "auto"` may resolve to `standard`.

    </Note>

  </Accordion>

  <Accordion title="Media understanding (image and PDF)">
    The bundled Anthropic plugin registers image and PDF understanding. OpenClaw
    auto-resolves media capabilities from the configured Anthropic auth; no
    additional config is needed.

    | Property        | Value                 |
    | --------------- | --------------------- |
    | Default model   | `claude-opus-4-8`     |
    | Supported input | Images, PDF documents |

    When an image or PDF is attached to a conversation, OpenClaw automatically
    routes it through the Anthropic media understanding provider.

  </Accordion>

  <Accordion title="1M context window">
    Claude Sonnet 5, Mythos 5, and Fable 5 have an exact 1,000,000-token input
    window and support up to 128,000 output tokens. Anthropic's 1M context
    window is also GA on Claude 4.x models with adaptive thinking: Opus 4.8,
    Opus 4.7, Opus 4.6, and Sonnet 4.6. OpenClaw sizes these models
    automatically, no `params.context1m` needed:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-5": {},
            "anthropic/claude-mythos-5": {},
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
    }
    ```

    Older configs can keep `params.context1m: true`; it is a harmless no-op for
    these models and OpenClaw no longer sends the retired
    `context-1m-2025-08-07` beta header regardless. Older `anthropicBeta` config
    entries with that value are dropped during request header resolution, and
    unsupported older Claude models stay on their normal context window.

    `params.context1m: true` behaves the same way for the Claude CLI backend
    (`claude-cli/*`): eligible GA-capable Opus and Sonnet models already get the
    1M window automatically, so the param is optional there too.

    <Warning>
    Requires long-context access on your Anthropic credential. OAuth/subscription token auth keeps its required Anthropic beta headers, but OpenClaw strips the retired 1M beta header if it remains in older config.
    </Warning>

  </Accordion>

  <Accordion title="Claude Opus 4.8 1M context">
    `anthropic/claude-opus-4-8` and its `claude-cli` variant have a 1M context
    window by default; no `params.context1m: true` needed.
  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="401 errors / token suddenly invalid">
    Anthropic token auth expires and can be revoked. For new setups, use an Anthropic API key instead.
  </Accordion>

  <Accordion title='No API key found for provider "anthropic"'>
    Anthropic auth is **per agent**; new agents do not inherit the main agent's keys. Re-run onboarding for that agent (or configure an API key on the gateway host), then verify with `openclaw models status`.
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
