---
summary: "Use Anthropic Claude via API keys or Claude CLI in OpenClaw"
read_when:
  - You want to use Anthropic models in OpenClaw
  - You want to browse Claude CLI or Claude Desktop sessions across paired computers
title: "Anthropic"
---

Anthropic builds the **Claude** model family. OpenClaw supports two auth routes:

- **API key** - direct Anthropic API access with usage-based billing (`anthropic/*` models)
- **Claude CLI** - reuse an existing Claude Code login through the installed executable on the same host

## Usage and cost tracking

OpenClaw detects the available Anthropic credential and selects the matching usage surface:

- OpenClaw-managed subscription/setup credentials show quota windows and optional extra-usage budget.
- Native Claude CLI logins stay under Claude's exclusive refresh control, so OpenClaw does not poll their quota endpoint.
- `ANTHROPIC_ADMIN_KEY` or `ANTHROPIC_ADMIN_API_KEY` shows 30 days of provider-reported organization cost and Messages API usage in Control UI **Usage**, including daily spend, token/cache totals, top models, and cost categories.
- An `sk-ant-admin...` credential stored in the Anthropic provider profile is detected as an Admin API key automatically.

Admin API cost history comes from Anthropic's [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api). It is actual provider billing, separate from OpenClaw's session-derived estimated cost.

<Warning>
Claude Code owns its existing login and subscription; OpenClaw does not persist
or refresh that login. Agent SDK and `claude -p`
usage currently draw from the signed-in subscription's limits. API-key auth
uses separate pay-as-you-go billing and is preferable for shared automation or
predictable production spend.

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
      env: { vars: { ANTHROPIC_API_KEY: "example-anthropic-key-not-real" } },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
    }
    ```

  </Tab>

  <Tab title="Claude CLI">
    **Best for:** reusing an existing Claude CLI login without a separate API key.

    <Steps>
      <Step title="Ensure Claude CLI is installed and logged in">
        OpenClaw communicates directly with the installed Claude Code executable.
        Verify that Claude Code is installed and up to date:

        ```bash
        claude --version
        claude auth status --text
        ```

        If Claude is not logged in, authenticate once as the Gateway user:

        ```bash
        claude auth login
        ```

        If the installed build is incompatible, update Claude Code and restart
        OpenClaw so the gateway launches the new binary:

        ```bash
        claude update
        ```
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        # choose: Claude CLI
        ```

        Normal agent turns use the installed, authenticated Claude Code executable
        through OpenClaw's direct CLI transport. OpenClaw uses a non-secret route
        marker and never reads, persists, refreshes, selects, or forwards the
        native login tokens. Claude owns the login and token refresh lifecycle.
        Gateway startup shares the native login availability check across agent
        workspaces using the same config and environment. Explicit catalog/auth
        captures recheck availability for their own generation.
        Explicitly selected API-key or token credentials still use protected
        file-descriptor forwarding. Native-tool approvals remain under OpenClaw
        control. Schema-valid native calls pass through OpenClaw's canonical
        tool policy before native approval. Isolated side-question completions
        and paired-node execution retain the supervised CLI path.

        Consecutive agent turns reuse the same warm Claude Code subprocess
        when their authenticated session and execution policy
        match. If that process ends or the gateway restarts, the next turn
        resumes the persisted Claude Code session.
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
          model: { primary: "anthropic/claude-opus-5" },
          models: {
            "anthropic/claude-opus-5": {
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

    Anthropic currently treats Agent SDK and non-interactive CLI invocations as
    programmatic usage:

    - Anthropic's June 15, 2026 support update paused the previously announced
      separate Agent SDK credit plan.
    - Subscription-plan Claude Agent SDK, `claude -p`, and third-party app usage
      still draw from the signed-in subscription's usage limits.
    - The previously announced monthly Agent SDK credit is not available while
      Anthropic revises that plan.
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

## Use Claude Fable 5.1

After setting up either auth route above, select the canonical model ref:

```bash
openclaw models set anthropic/claude-fable-5-1
```

For Claude CLI authentication, keep that same ref and select the CLI runtime:

```json5
{
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-fable-5-1" },
      models: {
        "anthropic/claude-fable-5-1": {
          agentRuntime: { id: "claude-cli" },
        },
      },
    },
  },
}
```

The API and Claude CLI catalogs expose a 1,000,000-token context window and
128,000-token output limit. Fable 5.1 always uses adaptive thinking, defaults to
`high`, and supports native `low`, `medium`, `high`, `xhigh`, and `max` effort.
For API-key billing, input and output remain `$10/$50` per million tokens;
cache reads cost `$0.25` per million tokens, one quarter of Fable 5's rate.
See Anthropic's [Fable 5.1 specifications](https://platform.claude.com/docs/en/models/fable-5-1/overview).

The bare `fable` alias now selects `anthropic/claude-fable-5-1`. Explicit
`fable-5` and `anthropic/claude-fable-5` selections still use Fable 5; OpenClaw
does not rewrite them to Fable 5.1.

### Tool calls and retained thinking

Fable 5.1 accepts automatic or disabled tool use, not forced tool calls.
OpenClaw's Anthropic adapter converts a forced tool choice to `auto`
when thinking is enabled. State in the prompt when a particular tool must run;
see Anthropic's [migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide).

Fable 5.1 binds retained thinking to the preceding system prompt, tools, and
conversation history. Changing that prefix can invalidate later thinking
blocks. Claude Code manages this history for the CLI runtime. OpenClaw's
embedded runtime uses append-only context only for prefix-binding models such as
Fable 5.1: it persists hidden runtime-context carriers after their user turn,
keeps earlier carriers and inline inbound metadata in place, and preserves
consecutive user turns on the Messages API. This also applies to matching Claude
models on Bedrock, Vertex, and Foundry, although Bedrock Converse still merges
consecutive user turns. Carriers contain only the delimited context body; the
instruction to use it privately lives once in the stable system prompt.
Other Claude models keep transient carriers and normal user-turn merging.
Transient carriers are the cheaper cache shape when thinking does not bind the
prefix: old carriers consume no later context or repeated cache-read charges.

Direct Anthropic API-key requests with adaptive thinking send the
`thinking-binding-controls-2026-08-01` beta and
`thinking.block_binding.prefix_mismatch_behavior: "drop_block"`. Anthropic drops
invalidated replayed thinking server-side, and OpenClaw logs a warning with the
count and up to five affected paths. These controls are not sent for OAuth,
proxies, Bedrock, Vertex, Foundry, or budget-based or disabled thinking.
Client-side compaction removes stale thinking signatures; a provider-confirmed
thinking rejection can still trigger one retry without prior thinking and
persist the successful repair. Adaptive mode remains enabled,
but a response may contain no thinking block. Integrations that build Messages API
requests directly should follow Anthropic's [preserved-thinking rules](https://platform.claude.com/docs/en/build-with-claude/thinking#preserved-thinking).

With `contextPruning.mode: "cache-ttl"`, direct Anthropic API-key requests use
[server-side tool-result clearing](/concepts/session-pruning#direct-anthropic-api-key-requests).
Anthropic's server-side clearing and compaction never invalidate Fable 5.1
thinking: the prefix check uses the history sent by the client, before those
server edits. See Anthropic's [context-editing contract](https://platform.claude.com/docs/en/build-with-claude/context-editing).
On other eligible routes, a client-side prune is a one-time prefix edit. OpenClaw
retains that projection for later requests, so pruning does not flip back to the
original bytes and invalidate newly created thinking. Earlier thinking affected
by a client-side edit is handled by `drop_block` where the binding controls above
apply, or by the existing rejection-and-repair path elsewhere.

Fable 5.1 thinking is also bound to the model that produced it. Switching a
session from Fable 5.1 to any other model (Opus 5, Sonnet 5, Fable 5, or
older) continues the visible conversation without Fable's earlier reasoning;
Anthropic drops those blocks unbilled, and OpenClaw's embedded runtime omits
them from the replay for the same result. The reverse move keeps reasoning:
Fable 5.1 reads thinking produced by Opus 5, Sonnet 5, Opus 4.8, and Fable 5,
so a session that moves onto Fable 5.1 replays that history intact. Switching
away and back does not restore the pre-switch Fable reasoning: the switch
changes the system prompt, which invalidates every earlier Fable block. On
direct API-key routes Anthropic drops those blocks server-side and OpenClaw
logs the drop; elsewhere, organizations that enforce the prefix check reject
the request once and the embedded runtime retries without prior thinking.
Changing the thinking level with `/think` has the same effect. Pick the model
and thinking level when you start the session when reasoning continuity
matters.

## Claude sessions across computers

The bundled Anthropic plugin adds a **Claude Code** group to the normal sessions
sidebar. Rows open in the normal Chat pane. It discovers non-archived Claude
Code sessions on the Gateway and on connected node hosts:

- Claude CLI sessions come from valid project-index records. For unindexed
  transcripts, a bounded metadata fallback recognizes concurrent non-sidechain
  interactive (`cli`) and headless Agent SDK CLI (`sdk-cli`) sessions under
  `~/.claude/projects/`.
- Claude Desktop sessions use the Desktop title, activity time, and
  archive state when its metadata points to the same Claude Code session ID.
- A CLI-only session has no archive flag, so it remains visible while its
  transcript is present.

Claude Code `/rename` titles take precedence over automatic titles and the first
prompt. `/color` imports the matching session color; cleared or unrecognized
colors stay unset. Discovery reads a bounded transcript prefix and tail, so recent
metadata appended to large transcripts is included without reading the entire
history. Metadata outside those windows may be unavailable. Desktop rows retain
their Desktop title and remain colorless.

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

Those refreshes are cheap on the Gateway: the plugin watches `~/.claude/projects/`
and the Desktop session store for changes instead of re-reading them on every
poll, so an unchanged tree costs no disk access and a change re-reads only the
affected project directory. It re-reads the whole tree at most every five
minutes as a backstop, and falls back to per-request scanning if the platform
cannot provide a file watcher. Desktop metadata also refreshes every 60 seconds
to pick up custom-group changes outside the watched session store.
Gateway enumeration keeps each caller isolated;
the plugin reuses its watched filesystem snapshot across those enumerations.

Catalog visibility follows the authenticated Gateway profile. Admin connections
see every discovered Claude row, and solo or shared-secret Gateways remain
unfiltered. On a multi-user Gateway, a non-admin sees only rows already adopted
by their durable profile; unattributed host-discovered Claude CLI and Desktop
rows stay hidden. This is a privacy control within one trusted Gateway domain;
see [Multi-user mode](/concepts/multi-user).

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

The new OpenClaw session starts with the catalog title and color. Continuing an
already adopted session preserves any title or color changes made in OpenClaw.

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
metadata or archives Claude sessions. Catalog list and read use `operator.read`,
while continuation uses `operator.write`. Paired-node command advertisement and
Gateway node policy remain additional requirements for node-backed rows.
</Note>

See [Nodes: Claude sessions and transcripts](/nodes#claude-sessions-and-transcripts)
for the node command and security boundary.

## Live model discovery

With an Anthropic API key configured, OpenClaw refreshes the Claude catalog from
Anthropic's models endpoint, so newly published snapshots of supported model
families appear without an OpenClaw release. Models the shipped catalog already
describes always keep their published metadata and pricing.

A newly discovered model is only offered when Anthropic's advertised
capabilities match the request shaping OpenClaw would apply to it. A brand-new
model generation therefore stays hidden until OpenClaw adds support for it,
rather than appearing in the picker and failing every request. Discovery is
advisory: without an API key, or if the endpoint is unreachable, the shipped
catalog is used unchanged.

## Thinking defaults (Claude Opus 5, Sonnet 5, Mythos 5, Fable 5, 4.8, and 4.6)

Bare family aliases are rolling: `opus` tracks the current supported Claude
Opus generation and today resolves to `anthropic/claude-opus-5`, the same way
`sonnet` tracks the current Sonnet. Upgrading OpenClaw can therefore move a
config that says `opus` onto a newer model generation. Pin a version to opt
out — versioned aliases such as `opus-4.8` keep resolving to their own model,
and configs that already name `claude-opus-4-8` are never rewritten.

`anthropic/claude-opus-5` uses adaptive thinking at `high` effort by default.
Use `/think off` to disable thinking, or `/think xhigh|max` for the model's
higher native effort levels. OpenClaw omits manual thinking budgets, custom
sampling parameters, assistant prefills, and Priority Tier for Opus 5 because
Anthropic does not support those request features on this model. The catalog
publishes its 1,000,000-token context window, 128,000-token output limit, image
input, and `$5/$25` input/output pricing.

`anthropic/claude-sonnet-5` uses the same adaptive-thinking defaults and request
restrictions. The catalog uses Anthropic's introductory `$2/$10` input/output
pricing through August 31, 2026; standard `$3/$15` pricing begins September 1, 2026.

`anthropic/claude-fable-5-1` and `anthropic/claude-fable-5` always use adaptive
thinking and default to `high` effort. Anthropic does not allow thinking to be
disabled for these models, so `/think off` and `/think minimal` map to `low`
effort instead. OpenClaw also omits caller-selected sampling parameters for
both Fable versions.

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
        "anthropic/claude-opus-5": {
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

## Safety refusal fallback (Claude Opus 5 and Fable 5)

<Warning>
Claude Opus 5, Fable 5.1, and Fable 5 can route a safety-classifier refusal to
another Claude model. OpenClaw opts into Anthropic's recommended per-category
routing for direct API-key requests. A fallback-served turn is billed at the model
that answered. If your policy requires every turn to stay on the requested
model, do not use these models through the automatic fallback path.
</Warning>

### Why this exists

Opus 5 and Fable classifiers return `stop_reason: "refusal"` on requests in
restricted domains. Without a fallback, the turn ends with an error even when
Anthropic has a recommended model for that refusal category.

### How it works

1. For every direct API-key request to `anthropic/claude-opus-5`,
   `anthropic/claude-fable-5-1`, or `anthropic/claude-fable-5`, OpenClaw sends the
   `server-side-fallback-2026-07-01` beta header plus
   `fallbacks: "default"`. Anthropic selects the recommended model for the
   reported refusal category.
2. Only a safety-classifier decline triggers the fallback. Rate limits,
   overloads, and server errors behave exactly as before and go through
   OpenClaw's normal [model failover](/concepts/model-failover).
3. The rescue happens inside the same call. A decline before any output is
   invisible apart from latency; the whole answer comes from the serving
   model. On a
   mid-stream decline the partial text is kept as the prefix the fallback
   model continues from, while the declined model's reasoning and tool calls
   are discarded per Anthropic's replay rules (they must not be echoed back or
   executed).
4. If the recommended model declines as well, the turn surfaces the refusal
   as an error. OpenClaw does not retry a final refusal or advance to another
   configured model.

The fallback happens at the Anthropic API level, so the serving model does not
need to be in your configured OpenClaw fallback chain.

### Observability and billing

- A fallback-served turn records a `provider_fallback` diagnostic on the
  assistant message naming `fromModel` and `toModel`, and the message's
  `responseModel` reports the model that answered.
- Anthropic bills the fallback attempt at the serving model's rates. OpenClaw
  prices known Opus 4.8 fallback-served turns at Opus 4.8 rates.
- A mid-stream decline additionally bills the already-streamed primary-model partial
  on Anthropic's side; that portion is reported in the API's per-attempt
  usage but not folded into OpenClaw's per-turn estimate.

### Scope

Applies to `anthropic/claude-opus-5`, `anthropic/claude-fable-5-1`, and
`anthropic/claude-fable-5` with API-key auth against `api.anthropic.com`.
OAuth (including Claude CLI subscription reuse), proxy base URLs, Bedrock,
Vertex, and Foundry requests are unchanged and still surface refusals as errors there.

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
    Use model-level params as your baseline, then override specific agents via `agents.entries.*.params`:

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
        entries: {
          research: { default: true },
          alerts: { params: { cacheRetention: "none" } },
        },
      },
    }
    ```

    Config merge order:

    1. `agents.defaults.models["provider/model"].params`
    2. `agents.entries.*.params` (matching `id`, overrides by key)

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
    For Claude Opus 5 and Opus 4.8, OpenClaw's shared `/fast` toggle uses
    Anthropic's native fast mode for direct API-key traffic to `api.anthropic.com`.

    | Command | Maps to |
    | --- | --- |
    | `/fast on` | `speed: "fast"` plus `fast-mode-2026-02-01` |
    | `/fast off` | Standard speed; no `speed` field |

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-5": {
              params: { fastMode: true },
            },
          },
        },
      },
    }
    ```

    <Note>
    - Native fast mode is a research preview for Claude Opus 5 and Opus 4.8. It can deliver up to 2.5x higher output-token throughput and is billed at `$10/$50` per million input/output tokens. OpenClaw applies the same 2x multiplier to cache pricing in its cost estimate.
    - Native fast mode only applies to direct `api.anthropic.com` requests made with an API key. OAuth/subscription-token requests, Claude CLI, proxies, Bedrock, Vertex, and Foundry never receive the beta or `speed` field.
    - Accounts need fast-mode access and a non-zero fast-mode rate limit. Anthropic returns a fast-specific `429` when the separate fast quota is exhausted or zero.
    - For other direct Anthropic models, `/fast` retains the existing Priority Tier mapping: on uses `service_tier: "auto"` and off uses `service_tier: "standard_only"`.
    - Explicit `serviceTier` or `service_tier` params override `/fast` when both are set.
    - Claude Sonnet 5 supports neither native fast mode nor Priority Tier, so OpenClaw omits both fields.

    </Note>

  </Accordion>

  <Accordion title="Server-side compaction">
    Anthropic server-side compaction is opt-in. For supported `anthropic/*`
    models using API-key auth directly against `api.anthropic.com`, enable it
    per model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: { anthropicServerCompaction: true },
            },
          },
        },
      },
    }
    ```

    OpenClaw adds the `compact-2026-01-12` beta header and sends an Anthropic
    `context_management` compaction edit. When compaction occurs, OpenClaw
    stores the newest summary as hidden provider replay state and sends it
    first on the next matching request. The full transcript remains local;
    only the outbound history before the checkpoint is omitted.
    If Anthropic rejects a stored checkpoint, that turn reports the provider
    error and the following turn falls back to full local history.

    When `anthropicCompactThreshold` is omitted, OpenClaw uses
    `max(50000, floor(contextWindow * 0.7))`. To choose a different input-token
    trigger:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: {
                anthropicServerCompaction: true,
                anthropicCompactThreshold: 120000,
              },
            },
          },
        },
      },
    }
    ```

    Configured thresholds below `50000` are clamped to `50000`.

    <Warning>
    Anthropic server-side compaction is a beta feature and OpenClaw never
    enables it automatically. It applies only to direct Anthropic API requests
    authenticated with an API key. OAuth/subscription tokens, Claude CLI,
    proxies, Bedrock, Vertex, and Foundry are excluded. OpenClaw does not send
    `pause_after_compaction` or custom compaction instructions.
    </Warning>

    See Anthropic's [compaction guide](https://platform.claude.com/docs/en/build-with-claude/compaction).

  </Accordion>

  <Accordion title="Media understanding (image and PDF)">
    The bundled Anthropic plugin registers image and PDF understanding. OpenClaw
    auto-resolves media capabilities from the configured Anthropic auth; no
    additional config is needed.

    | Property        | Value                 |
    | --------------- | --------------------- |
    | Default model   | `claude-opus-5`       |
    | Supported input | Images, PDF documents |

    When an image or PDF is attached to a conversation, OpenClaw automatically
    routes it through the Anthropic media understanding provider.

  </Accordion>

  <Accordion title="1M context window">
    Claude Opus 5, Sonnet 5, Mythos 5, Fable 5.1, and Fable 5 have an exact
    1,000,000-token input window and support up to 128,000 output tokens.
    Anthropic's 1M context window is also GA on Claude 4.x models with adaptive
    thinking: Opus 4.8,
    Opus 4.7, Opus 4.6, and Sonnet 4.6. OpenClaw sizes these models
    automatically, no `params.context1m` needed:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-5": {},
            "anthropic/claude-sonnet-5": {},
            "anthropic/claude-mythos-5": {},
            "anthropic/claude-opus-4-8": {},
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

    Claude CLI (`claude-cli/*`) has its own context budget. For older models
    such as Sonnet 4.6, API availability does not automatically select the CLI's
    extended context. OpenClaw uses CLI-owned metadata and configured limits;
    an eligible `[1m]` model ref or `params.context1m: true` selects a 1M budget.
    Native extended-context access still depends on the installed CLI and your
    account; see [Claude Code extended context](https://code.claude.com/docs/en/model-config#extended-context).

    <Warning>
    Requires long-context access on your Anthropic credential. OAuth/subscription token auth keeps its required Anthropic beta headers, but OpenClaw strips the retired 1M beta header if it remains in older config.
    </Warning>

  </Accordion>

  <Accordion title="Claude Opus 5 1M context">
    `anthropic/claude-opus-5` and its `claude-cli` variant have a 1M context
    window by default; no `params.context1m: true` needed.
  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Claude CLI OAuth session expired or could not be refreshed">
    Run these commands as the Gateway user on the Gateway host:

    ```bash
    claude auth status --text
    claude auth login
    openclaw gateway restart
    ```

    Claude Code owns its login and refresh lifecycle; do not copy an OAuth token into OpenClaw.

  </Accordion>

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
