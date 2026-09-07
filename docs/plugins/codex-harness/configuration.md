---
summary: "Codex harness config map, restricted turns, project instructions, compaction, and long context"
read_when:
  - You need the Codex harness config map
  - You are tuning compaction or project instructions
  - You are configuring the direct OpenAI API long-context route
title: "Codex harness configuration"
sidebarTitle: "Configuration"
---

The Codex harness configuration map and the turn-level behavior each setting controls. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Configuration

| Need                                                | Set                                                                                                       | Where                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Enable the harness                                  | `plugins.entries.codex.enabled: true`                                                                     | OpenClaw config                    |
| Hide native Codex session discovery                 | `plugins.entries.codex.config.sessionCatalog.enabled: false`                                              | Codex plugin config                |
| Include additional local Codex stores (stdio only)  | `plugins.entries.codex.config.sessionCatalog.homes`                                                       | Codex plugin config                |
| Keep an allowlisted plugin install                  | Include `codex` in `plugins.allow`                                                                        | OpenClaw config                    |
| Allow eligible OpenAI turns to use Codex implicitly | Exact official HTTPS Responses/ChatGPT route, no authored provider request override, runtime unset/`auto` | OpenAI provider/model config       |
| Sign in with ChatGPT/Codex OAuth                    | `openclaw models auth login --provider openai`                                                            | CLI auth profile                   |
| Add API-key backup for Codex runs                   | `openai:*` API-key profile listed after subscription auth in `auth.order.openai`                          | CLI auth profile + OpenClaw config |
| Fail closed when Codex is unavailable               | Provider or model `agentRuntime.id: "codex"`                                                              | OpenClaw model/provider config     |
| Use direct OpenAI API traffic                       | Provider or model `agentRuntime.id: "openclaw"` with normal OpenAI auth                                   | OpenClaw model/provider config     |
| Tune app-server behavior                            | `plugins.entries.codex.config.appServer.*`                                                                | Codex plugin config                |
| Enable native Codex plugin apps                     | `plugins.entries.codex.config.codexPlugins.*`                                                             | Codex plugin config                |
| Enable Codex Computer Use                           | `plugins.entries.codex.config.computerUse.*`                                                              | Codex plugin config                |

Prefer `auth.order.openai` for subscription-first/API-key-backup ordering.
Existing legacy Codex auth profile ids and legacy Codex auth order are
doctor-only legacy state; do not write new legacy Codex GPT refs.

```json5
{
  auth: {
    order: {
      openai: ["openai:user@example.com", "openai:api-key-backup"],
    },
  },
}
```

For a Codex-compatible effective route, both profiles above remain candidates
for the same Codex run. Profile order chooses credentials, not the runtime.
Changing auth order does not make a custom, Completions, HTTP, or
request-overridden route Codex-compatible. Valid model-scoped Fast-mode and
cutoff controls are runtime controls, not request overrides.

### Restricted turns and ring zero

OpenClaw applies Codex restrictions per turn, not as a permanent session mode.
An existing session can therefore run one restricted turn and return to its
normal Codex thread on the next unrestricted turn. When a restriction is
temporary, OpenClaw preserves the normal thread binding and uses a temporary
restricted thread where necessary.

An ordinary **policy-restricted turn** occurs when an explicit OpenClaw tool
policy cannot be mapped safely onto Codex's native tool surface. Common
triggers include:

- a finite `tools.allow` list or an internal per-run allowlist
- `disableTools` or a sender/group policy that denies all tools
- a `tools.deny` entry with a wildcard, tool group, unknown name, or name that
  is not in the Codex harness's audited safe-deny set
- an applicable agent, provider, group, sender, sandbox, subagent, inherited,
  scheduled, or runtime tool policy with one of those restrictions

Default tool-profile narrowing alone does not trigger this mode. A deny list
containing only audited OpenClaw-owned tools can also stay on the normal native
surface; the harness enforces those denies without disabling unrelated Codex
capabilities. See [Native tool-policy enforcement](/plugins/sdk-agent-harness#native-tool-policy-enforcement)
for the generic harness contract and [Codex harness reference](/plugins/codex-harness-reference#restricted-turns)
for the current Codex rules.

For an ordinary policy-restricted turn, OpenClaw disables Codex native Code
Mode, removes environment selections, disables and verifies inherited and
native configured MCP servers, and disables native hook relays. Static configured
MCP tools that pass the effective policy move to OpenClaw's dynamic surface for
that turn. Other OpenClaw dynamic tools use the same policy. The bounded workspace `AGENTS.md`
snapshot still reaches the model as thread-level developer instructions because
project instructions are context, not tool authority.

**Ring zero** is stronger and separate. It is the host-owned OpenClaw system
agent used for setup and repair operations. The host activates it with the
single `openclaw` tool; normal agent config cannot opt a chat into ring zero.
Ring-zero turns keep only that host-scoped tool, replace ambient Codex
instructions with host-authored setup instructions, disable native tools and
MCP servers, and suppress workspace project documents, including the
`AGENTS.md` developer-instruction carrier.

Other narrow internal modes also suppress project documents: lightweight
bootstrap turns, message-only source replies, and tool-disabled internal turns.
They share some isolation settings with policy-restricted turns but are not
synonyms for ring zero.

### Project instructions

Codex loads `AGENTS.md` files through native project-document discovery. For
normal app-server threads, OpenClaw raises Codex's aggregate root-to-working-
directory budget from the upstream 32 KiB default to a bounded 128 KiB so later
scoped instructions are not silently clipped. Ordinary conversation tool-policy
restrictions preserve that budget because project instructions are context, not
tool authority. Their isolated native environment cannot read workspace files,
so OpenClaw supplies the bounded workspace `AGENTS.md` snapshot as thread-level
developer instructions. Lightweight, ring-zero, message-only, and tool-disabled
internal turns set the native project-document budget to zero instead.

This byte budget is separate from the character-based workspace bootstrap
limits configured through `agents.defaults.bootstrapMaxChars` and
`agents.defaults.bootstrapTotalMaxChars`.

`/context` reports native project documents as unverified because app-server
exposes their source paths but not the retained byte counts needed to tell
whether any individual file was fully loaded or truncated.

### Compaction

Do not set `compaction.model` or `compaction.provider` on Codex-backed
agents. Codex compacts through its native app-server thread state, so
OpenClaw ignores those local summarizer overrides at runtime, and
`openclaw doctor --fix` removes them when the agent uses Codex.

An authored `models.providers.*.models[].contextTokens` cap is forwarded to
Codex thread start and resume as `model_context_window`. Codex clamps the value
to the model's native maximum and derives automatic compaction from the capped
window. When the model entry has no authored cap, OpenClaw sends no override.

Lossless remains supported as a context engine for assembly, ingestion, and
maintenance around Codex turns, configured through
`plugins.slots.contextEngine: "lossless-claw"` and
`plugins.entries.lossless-claw.config.summaryModel`, not through
`agents.defaults.compaction.provider`. `openclaw doctor --fix` migrates the
old `compaction.provider: "lossless-claw"` shape to the Lossless
context-engine slot when Codex is the active runtime, but native Codex still
owns compaction. The native app-server harness supports context engines
that need pre-prompt assembly; generic CLI backends, including `codex-cli`,
do not provide that host capability.

For Codex-backed agents, `/compact` starts native Codex app-server
compaction on the bound thread and waits for its terminal result. The shared
`agents.defaults.compaction.timeoutSeconds` budget applies; on timeout,
OpenClaw asks Codex to interrupt the native turn and keeps the per-thread fence
until termination is confirmed. It never falls back to a context engine or
public OpenAI summarizer. If the native Codex thread binding is missing or
stale, the command fails closed instead of silently switching compaction
backends.

### Direct API long context

Codex subscription and direct OpenAI API traffic are separate contracts. The
live ChatGPT/Codex catalog commonly exposes a `272000` token model window,
while OpenAI documents a `1050000` token Platform API window and `128000`
maximum output for GPT-5.5 and GPT-5.6. Both runtime translations use the same
safe arithmetic:

```text
1050000 total - 128000 maximum output = 922000 safe active input
automatic compaction threshold = 700000 active tokens
```

The native Codex translation is not a Responses parameter set. Codex owns the
native thread's context and compaction, so do not add
`responsesServerCompaction` or `responsesCompactThreshold` to a Codex-backed
model.

Start from a complete Codex model catalog compatible with the installed Codex
version. For the exact `gpt-5.6-sol` entry, preserve the rest of the descriptor
and set:

```json
{
  "context_window": 922000,
  "max_context_window": 922000,
  "auto_compact_token_limit": 700000
}
```

Codex applies its normal 95% effective-window reserve to the `922000` catalog
value, so it reports exactly `875900` usable tokens. Compacting at `700000`
leaves `175900` tokens before that effective guard and `222000` before the
provider-safe input allowance. This larger margin is deliberate: Codex checks
already-recorded context before adding the next user message and context
updates, so the threshold must cover one large incoming turn as well as tools,
instructions, serialization, and the compaction turn itself.

For standalone Codex CLI or Desktop use, a command-auth custom provider can
read the API key from a system keychain or secret manager while the normal
ChatGPT login remains available for connectors:

```toml
model = "gpt-5.6-sol"
model_provider = "openai_api_direct"
model_context_window = 922000
model_auto_compact_token_limit = 700000
model_auto_compact_token_limit_scope = "total"
model_catalog_json = "/absolute/path/to/models-api-1m.json"

[model_providers.openai_api_direct]
name = "OpenAI API direct"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.openai_api_direct.auth]
command = "/absolute/path/to/read-openai-inference-key"
timeout_ms = 5000
refresh_interval_ms = 300000
```

The auth helper must print only the key to stdout. Do not put it in TOML.

For the OpenClaw Codex app-server harness, keep the default agent-scoped Codex
home and let OpenClaw inject an `openai` API-key profile. Create the profile by
the normal OpenAI API-key auth flow, put its actual id first in
`auth.order.openai`, and pass the catalog and context limits as native Codex
app-server arguments:

```json5
{
  auth: {
    order: {
      openai: ["openai:api-key"],
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            args: [
              "app-server",
              "--listen",
              "stdio://",
              "-c",
              'model_catalog_json="/absolute/path/to/models-api-1m.json"',
              "-c",
              "model_context_window=922000",
              "-c",
              "model_auto_compact_token_limit=700000",
              "-c",
              "model_auto_compact_token_limit_scope=total",
            ],
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      models: {
        "openai/gpt-5.6-sol": {
          agentRuntime: { id: "codex" },
          params: { fastMode: true },
        },
      },
    },
  },
}
```

Replace `openai:api-key` with the actual API-key profile id. The
agent-scoped app-server receives only that prepared key; the operator's native
`~/.codex` ChatGPT login, plugins, connectors, and thread store remain
untouched. Use the injected agent-scoped API-key path above for this route
rather than relying on `homeScope: "user"` to provide the intended credential.

The model catalog, `model_context_window`, total-scope automatic compaction
limit, exact `openai/gpt-5.6-sol` route, and API-key profile order form one
configuration unit. Apply them together. OpenClaw can keep embedded and native
long-context choices at the same time only when their model refs or agent
configurations are distinguishable; one model entry cannot carry both
runtime-owned compaction strategies.

After changing the catalog or app-server arguments, restart the Gateway and
native Codex app-server, then start a fresh chat. Run `/model default -s` when
an existing session has a model or runtime override. Existing native threads
preserve their recorded provider and model settings. Verify the runtime with
`/status` and `/codex status`, then send a harmless direct API turn before
starting a long session.

A process-owned isolated Gateway and app-server run verified this exact
`openai/gpt-5.6-sol` API-key configuration. Codex reported an effective window
of `875900`. Active context grew from `197032` to `377386`, `561957`, and
`750745` tokens without manual compaction; the next small turn triggered
automatic compaction to `75980` active tokens, with a minimum after-compaction
snapshot of `68375`. Compaction took `2810` ms and persisted a count of one. A
durable marker survived compaction and restart, a deterministic long response
produced `5442` output tokens, and OpenClaw sent the Codex app-server tier
`priority` on every call. That request evidence does not prove which upstream
tier processed each call. The full suite took `401.37` seconds. These timings
are observations, not service-level guarantees.

<Warning>
Long context is deliberately opt-in. Once input exceeds `272000` tokens,
OpenAI bills the entire request at 2× input and cache rates and 1.5× output
rates. Fast-mode pricing is model-specific; GPT-5.6 Sol API Fast mode (formerly
Priority processing) is currently another 2× over Standard, so this recipe is
4× short-context Standard input-side pricing and 3× short-context Standard
output pricing. OpenClaw currently sends the wire value
`service_tier: "priority"`. ChatGPT/Codex-credit Fast mode is separate: GPT-5.6
and GPT-5.5 currently consume 2.5× Standard credits, while this API-key Codex
route uses API token pricing. The API remains authoritative for access, actual
limits, and billing. See
[OpenAI model limits](https://developers.openai.com/api/docs/models/compare),
[Fast mode](https://openai.com/api-priority-processing/),
[API pricing](https://developers.openai.com/api/docs/pricing), and
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).
</Warning>

The rest of this guide covers
[deployment shape and fail-closed routing](/plugins/codex-harness/routing),
[guardian approval policy](/plugins/codex-harness/app-server), and
[native Codex plugins and Computer Use](/plugins/codex-harness/native-features).
For full option lists, defaults, enums, discovery, environment isolation,
timeouts, and app-server transport fields, see
[Codex harness reference](/plugins/codex-harness-reference).
