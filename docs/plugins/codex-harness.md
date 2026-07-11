---
summary: "Run OpenClaw embedded agent turns through the official Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the official Codex app-server harness
  - You need Codex harness config examples
  - You want Codex-only deployments to fail instead of falling back to OpenClaw
---

The official `codex` plugin runs embedded OpenAI agent turns through Codex
app-server instead of the built-in OpenClaw harness. Codex owns the
low-level agent session: native thread resume, native tool continuation,
native compaction, and app-server execution. OpenClaw still owns chat
channels, session files, model selection, OpenClaw dynamic tools, approvals,
media delivery, and the visible transcript mirror.

Use canonical OpenAI model refs such as `openai/gpt-5.6-sol`. Do not configure
legacy Codex GPT refs; put OpenAI agent auth order under `auth.order.openai`.
Legacy Codex auth profile ids and legacy Codex auth order entries are
repaired by `openclaw doctor --fix`.

With provider/model runtime policy unset or `auto`, the `openai/*` prefix alone
never selects this harness. OpenAI may select Codex implicitly only for an
exact official HTTPS Platform Responses or ChatGPT Responses route with no
authored request override. See
[OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).
If Codex owns auth before Platform versus ChatGPT routing is known, OpenClaw
still requires every candidate route to declare Codex compatibility. Native
auth ownership alone never bypasses that route check.

When no OpenClaw sandbox is active, OpenClaw starts Codex app-server threads
with Codex native code mode enabled (code-mode-only stays off by default), so
native workspace/code capabilities remain available alongside OpenClaw
dynamic tools routed through the app-server `item/tool/call` bridge. An
active OpenClaw sandbox or restricted tool policy disables native code mode
entirely unless you opt into the experimental sandbox exec-server path.

With the default `tools.exec.host: "auto"` and no active OpenClaw sandbox,
Codex also receives `node_exec` and `node_process` tools for commands on paired
nodes. Native shell remains on the Codex app-server host and workspace
(Gateway-local for the default stdio deployment); `node_exec` selects a node by
name or id and keeps OpenClaw's node approval policy in force.

This Codex-native feature is separate from
[OpenClaw code mode](/reference/code-mode), an opt-in QuickJS-WASI runtime
for generic OpenClaw runs with a different `exec` input shape. For the
broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes): `openai/gpt-5.6-sol` is the model
ref, `codex` is the runtime, and Telegram, Discord, Slack, or another
channel is the communication surface.

## Requirements

- The official `@openclaw/codex` plugin installed. Include `codex` in
  `plugins.allow` if your config uses an allowlist.
- Codex app-server `0.143.0` or newer. The plugin manages a compatible
  binary by default, so a `codex` command on `PATH` does not affect normal
  startup.
- Codex auth through `openclaw models auth login --provider openai`, an
  app-server account already present in the agent's Codex home, or an
  explicit Codex API-key auth profile.

For auth precedence, environment isolation, custom app-server commands,
model discovery, and the full config field list, see
[Codex harness reference](/plugins/codex-harness-reference).

## Quickstart

Install the official plugin, then sign in with Codex OAuth:

```bash
openclaw plugins install @openclaw/codex
openclaw models auth login --provider openai
```

Enable the `codex` plugin and select an OpenAI agent model:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

If your config uses `plugins.allow`, add `codex` there too:

```json5
{
  plugins: {
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

Restart the gateway after changing plugin config. If a chat already has a
session, run `/new` or `/reset` first so the next turn resolves the harness
from current config.

## Share threads with Codex Desktop and CLI

The default `appServer.homeScope: "agent"` isolates each OpenClaw agent from
the operator's native Codex state. To let an owner inspect and manage the
same native threads shown by Codex Desktop and the Codex CLI, opt into the
user Codex home:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            homeScope: "user",
          },
        },
      },
    },
  },
}
```

User-home mode supports a local managed stdio process or the shared Unix-socket
transport. It uses `$CODEX_HOME` when set and `~/.codex` otherwise, including
that home's native Codex auth, config, plugins, and thread store. OpenClaw does
not inject an OpenClaw auth profile into this app-server.

Owner turns gain the `codex_threads` tool: list, search, read, fork, rename,
archive, and restore native threads. Fork a thread to continue it in
OpenClaw; the fork attaches to the current OpenClaw session and stays
visible to other native Codex clients. Archiving requires explicit
confirmation that the thread is closed elsewhere. When supervision is also
enabled, transcript fields and mutations require the matching
`supervision.allowRawTranscripts` or `supervision.allowWriteControls` opt-in.

Do not resume or write the same thread concurrently through independent managed
stdio App Servers. Codex coordinates live writers inside one App Server, not
across separate processes. Forking is the safe coexistence path for ordinary
user-home stdio sessions.

`appServer.homeScope: "user"` alone does not enable the fleet catalog. Use
`supervision.enabled: true` when you want native sessions to appear in the
OpenClaw sidebar. Supervision uses a separate supervision connection; without
explicit `appServer` connection settings, that connection defaults to managed
user-home stdio while the ordinary harness stays agent-scoped. Explicit
`appServer` settings are honored by both paths. Set `homeScope: "user"`
explicitly, as above, when the ordinary harness should also share native state.

## Supervise Codex sessions

The same `codex` plugin can list non-archived Codex sessions from the Gateway
computer and opted-in paired nodes. A stored or idle Gateway-local session can
create a model-locked Chat that mirrors its bounded persisted user and assistant
history. Its private binding uses the supervision connection for the native
snapshot, canonical branch, and later turns while ordinary Codex sessions remain
agent-scoped. The first canonical start uses exactly the model and provider that
Codex returns for the snapshot fork. Later resumes leave selection to Codex's
native configuration; the outer OpenClaw model and fallback chain never replace
it. Stored and idle rows can be archived after explicit no-other-runner
confirmation. Active sources cannot create a branch or be archived; an existing
supervised Chat can still be opened. Paired-node sessions remain metadata-only.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup, branching
rules, paired-node limits, metadata exposure, and troubleshooting.

## Configuration

| Need                                                | Set                                                                                              | Where                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Enable the harness                                  | `plugins.entries.codex.enabled: true`                                                            | OpenClaw config                    |
| Show non-archived Codex sessions                    | `plugins.entries.codex.config.supervision.enabled: true`                                         | Codex plugin config                |
| Keep an allowlisted plugin install                  | Include `codex` in `plugins.allow`                                                               | OpenClaw config                    |
| Allow eligible OpenAI turns to use Codex implicitly | Exact official HTTPS Responses/ChatGPT route, no authored request override, runtime unset/`auto` | OpenAI provider/model config       |
| Sign in with ChatGPT/Codex OAuth                    | `openclaw models auth login --provider openai`                                                   | CLI auth profile                   |
| Add API-key backup for Codex runs                   | `openai:*` API-key profile listed after subscription auth in `auth.order.openai`                 | CLI auth profile + OpenClaw config |
| Fail closed when Codex is unavailable               | Provider or model `agentRuntime.id: "codex"`                                                     | OpenClaw model/provider config     |
| Use direct OpenAI API traffic                       | Provider or model `agentRuntime.id: "openclaw"` with normal OpenAI auth                          | OpenClaw model/provider config     |
| Tune app-server behavior                            | `plugins.entries.codex.config.appServer.*`                                                       | Codex plugin config                |
| Enable native Codex plugin apps                     | `plugins.entries.codex.config.codexPlugins.*`                                                    | Codex plugin config                |
| Enable Codex Computer Use                           | `plugins.entries.codex.config.computerUse.*`                                                     | Codex plugin config                |

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
request-overridden route Codex-compatible.

### Compaction

Do not set `compaction.model` or `compaction.provider` on Codex-backed
agents. Codex compacts through its native app-server thread state, so
OpenClaw ignores those local summarizer overrides at runtime, and
`openclaw doctor --fix` removes them when the agent uses Codex.

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
compaction on the bound thread. OpenClaw does not wait for completion,
impose an OpenClaw timeout, restart the shared app-server, or fall back to a
context-engine or public OpenAI summarizer. If the native Codex thread
binding is missing or stale, the command fails closed instead of silently
switching compaction backends.

The rest of this page covers deployment shape, fail-closed routing, guardian
approval policy, native Codex plugins, and Computer Use. For full option
lists, defaults, enums, discovery, environment isolation, timeouts, and
app-server transport fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Verify Codex runtime

Use `/status` in the chat where you expect Codex. A Codex-backed OpenAI
agent turn shows:

```text
Runtime: OpenAI Codex
```

Then check Codex app-server state:

```text
/codex status
/codex models
```

`/codex status` reports app-server connectivity, account, rate limits, MCP
servers, and skills. `/codex models` lists the live Codex app-server catalog
for the harness and account. If `/status` is surprising, see
[Troubleshooting](#troubleshooting).

## Routing and model selection

Keep provider refs and runtime policy separate:

- Use `openai/gpt-*` for canonical OpenAI model selection. The prefix alone
  never selects Codex.
- With runtime unset or `auto`, only an exact official HTTPS Platform Responses
  or ChatGPT Responses route with no authored request override may select Codex
  implicitly.
- Do not use legacy Codex GPT refs in config; run `openclaw doctor --fix` to
  repair legacy refs and stale session route pins.
- `agentRuntime.id: "codex"` makes Codex a fail-closed requirement for a
  compatible route. It does not make an incompatible effective route compatible.
- `agentRuntime.id: "openclaw"` opts a provider or model into the embedded
  OpenClaw runtime when that is intentional.
- `/codex ...` controls native Codex app-server conversations from chat.
- ACP/acpx is a separate external harness path. Use it only when the user
  asks for ACP/acpx or an external harness adapter.

| User intent                                                | Use                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Attach the current chat                                    | `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`                    |
| Resume an existing Codex thread                            | `/codex resume <thread-id>`                                                                           |
| List or filter Codex threads                               | `/codex threads [filter]`                                                                             |
| List native Codex plugins                                  | `/codex plugins list`                                                                                 |
| Enable or disable a configured native Codex plugin         | `/codex plugins enable <name>`, `/codex plugins disable <name>`                                       |
| Resume a stored Codex CLI session as a paired-node turn    | `/codex sessions --host <node> [filter]`, then `/codex resume <session-id> --host <node> --bind here` |
| View non-archived Codex sessions across computers          | Enable Codex supervision and open **Codex Sessions**                                                  |
| Change the bound thread's model, fast-mode, or permissions | `/codex model <model>`, `/codex fast [on\|off\|status]`, `/codex permissions [default\|yolo\|status]` |
| Stop or steer the active turn                              | `/codex stop`, `/codex steer <text>`                                                                  |
| Detach the current binding                                 | `/codex detach` (alias `/codex unbind`)                                                               |
| Send Codex feedback only                                   | `/codex diagnostics [note]`                                                                           |
| Start an ACP/acpx task                                     | ACP/acpx session commands, not `/codex`                                                               |

| Use case                                        | Configure                                                                                                   | Verify                                  | Notes                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| Eligible OpenAI route with native Codex runtime | Exact official HTTPS Responses/ChatGPT route with no authored request override, plus enabled `codex` plugin | `/status` shows `Runtime: OpenAI Codex` | Implicit path when runtime is unset/`auto` |
| Fail closed if Codex is unavailable             | Provider or model `agentRuntime.id: "codex"`                                                                | Turn fails instead of embedded fallback | Use for Codex-only deployments             |
| Direct OpenAI API-key traffic through OpenClaw  | Provider or model `agentRuntime.id: "openclaw"` and normal OpenAI auth                                      | `/status` shows OpenClaw runtime        | Use only when OpenClaw is intentional      |
| Legacy config                                   | legacy Codex GPT refs                                                                                       | `openclaw doctor --fix` rewrites it     | Do not write new config this way           |
| ACP/acpx Codex adapter                          | ACP `sessions_spawn({ runtime: "acp" })`                                                                    | ACP task/session status                 | Separate from native Codex harness         |

`agents.defaults.imageModel` follows the same prefix split. Use `openai/gpt-*`
for the normal OpenAI route and `codex/gpt-*` only when image understanding
should run through a bounded Codex app-server turn. Doctor rewrites legacy
Codex GPT refs to `openai/gpt-*`.

## Deployment patterns

### Basic Codex deployment

Use the quickstart config for an OpenAI model whose effective official HTTPS
route is eligible to select Codex implicitly:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

### Mixed provider deployment

Keep Claude as the default agent and add a named Codex agent:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
    list: [
      {
        id: "main",
        default: true,
        model: "anthropic/claude-opus-4-6",
      },
      {
        id: "codex",
        name: "Codex",
        model: "openai/gpt-5.6-sol",
      },
    ],
  },
}
```

The `main` agent uses its normal provider path. The `codex` agent uses Codex
app-server when its effective OpenAI route remains compatible; add explicit
model-scoped `agentRuntime.id: "codex"` when that should be a fail-closed
requirement.

### Fail-closed Codex deployment

An eligible exact official HTTPS OpenAI route can resolve to Codex when the
bundled plugin is available. Add explicit runtime policy for a written
fail-closed rule:

```json5
{
  models: {
    providers: {
      openai: {
        agentRuntime: {
          id: "codex",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

With Codex forced, OpenClaw fails early if the effective route is not declared
Codex-compatible, the plugin is disabled, the app-server is too old, or the
app-server cannot start.

## App-server policy

By default, the plugin starts OpenClaw's managed Codex binary locally with
stdio transport. Set `appServer.command` only to intentionally run a
different executable. Use WebSocket transport only when an app-server is
already running elsewhere:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://gateway-host:39175",
            authToken: "${CODEX_APP_SERVER_TOKEN}",
          },
        },
      },
    },
  },
}
```

Local stdio app-server sessions default to the trusted local operator
posture: `approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. If local Codex requirements disallow that
implicit YOLO posture, OpenClaw selects allowed guardian permissions
instead. When an OpenClaw sandbox is active for the session, OpenClaw
disables Codex native Code Mode, user MCP servers, and app-backed plugin
execution for that turn instead of relying on Codex host-side sandboxing.
Shell access instead goes through OpenClaw sandbox-backed dynamic tools such
as `sandbox_exec` and `sandbox_process` when the normal exec/process tools
are available.

Use normalized OpenClaw exec mode for Codex native auto-review before
sandbox escapes or extra permissions:

```json5
{
  tools: {
    exec: {
      mode: "auto",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

For Codex app-server sessions, `tools.exec.mode: "auto"` maps to Codex
Guardian-reviewed approvals: usually `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"` when
local requirements allow those values. In `tools.exec.mode: "auto"`,
OpenClaw does not preserve legacy unsafe Codex `approvalPolicy: "never"` or
`sandbox: "danger-full-access"` overrides; use `tools.exec.mode: "full"` for
an intentional no-approval Codex posture. The legacy
`plugins.entries.codex.config.appServer.mode: "guardian"` preset still
works, but `tools.exec.mode: "auto"` is the normalized OpenClaw surface.

For the mode-level comparison with host exec approvals and ACPX
permissions, see [Permission modes](/tools/permission-modes). For every
app-server field, auth order, environment isolation, and timeout behavior,
see [Codex harness reference](/plugins/codex-harness-reference).

## Commands and diagnostics

The `codex` plugin registers `/codex` as a slash command on any channel that
supports OpenClaw text commands.

Native execution and control require an owner or an `operator.admin`
Gateway client: binding or resuming threads, sending or stopping turns,
changing model, fast-mode, or permission state, compacting or reviewing, and
detaching a binding. Other authorized senders keep read-only status, help,
account, model, thread, MCP server, skill, and binding inspection commands.

Common forms:

- `/codex status` checks app-server connectivity, models, account, rate
  limits, MCP servers, and skills.
- `/codex models` lists live Codex app-server models.
- `/codex threads [filter]` lists recent Codex app-server threads.
- `/codex resume <thread-id>` attaches the current OpenClaw session to an
  existing Codex thread.
- `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`
  attaches the current chat.
- `/codex detach` (or `/codex unbind`) detaches the current binding.
- `/codex binding` describes the current binding.
- `/codex stop` stops the active turn; `/codex steer <text>` steers it.
- `/codex model <model>`, `/codex fast [on|off|status]`, and
  `/codex permissions [default|yolo|status]` change per-conversation state.
- `/codex compact` asks Codex app-server to compact the attached thread.
- `/codex review` starts Codex native review for the attached thread.
- `/codex diagnostics [note]` asks before sending Codex feedback for the
  attached thread.
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.
- `/codex plugins list`, `/codex plugins enable <name>`, and
  `/codex plugins disable <name>` manage configured native Codex plugins.
- `/codex computer-use [status|install]` manages Codex Computer Use.
- `/codex help` lists the full command tree.

For most support reports, start with `/diagnostics [note]` in the
conversation where the bug happened. It creates one Gateway diagnostics
report and, for Codex harness sessions, asks for approval to send the
relevant Codex feedback bundle. See
[Diagnostics export](/gateway/diagnostics) for the privacy model and group
chat behavior. Use `/codex diagnostics [note]` only when you specifically
want the Codex feedback upload for the currently attached thread without
the full Gateway diagnostics bundle.

### Inspect Codex threads locally

The fastest way to inspect a bad Codex run is often to open the native
Codex thread directly:

```bash
codex resume <thread-id>
```

Get the thread id from the completed `/diagnostics` reply, `/codex binding`,
or `/codex threads [filter]`.

For upload mechanics and runtime-level diagnostics boundaries, see
[Codex harness runtime](/plugins/codex-harness-runtime#codex-feedback-upload).

### Auth order

In the default per-agent home, auth is selected in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Run `openclaw doctor --fix` to migrate older legacy
   Codex auth profile ids and legacy Codex auth order.
2. The app-server's existing account in that agent's Codex home.
3. For local stdio app-server launches only, `CODEX_API_KEY`, then
   `OPENAI_API_KEY`, when no app-server account is present and OpenAI auth
   is still required.

When OpenClaw sees a ChatGPT subscription-style Codex auth profile, it
removes `CODEX_API_KEY` and `OPENAI_API_KEY` from the spawned Codex child
process. That keeps Gateway-level API keys available for embeddings or
direct OpenAI models without making native Codex app-server turns bill
through the API by accident. Explicit Codex API-key profiles and local
stdio env-key fallback use app-server login instead of inherited
child-process env. WebSocket app-server connections do not receive Gateway
env API-key fallback; use an explicit auth profile or the remote
app-server's own account.

If a subscription profile hits a Codex usage limit, OpenClaw records the
reset time when Codex reports one and tries the next ordered auth profile
for the same Codex run. When the reset time passes, the subscription
profile becomes eligible again without changing the selected `openai/gpt-*`
model or Codex runtime.

When native Codex plugins are configured, OpenClaw installs or refreshes
those plugins through the connected app-server before exposing plugin-owned
apps to the Codex thread. `app/list` remains the source of truth for app
ids, accessibility, and metadata, but OpenClaw owns the per-thread
enablement decision: if policy allows a listed accessible app, OpenClaw
sends `thread/start.config.apps[appId].enabled = true` even when `app/list`
currently reports that app disabled. This path does not invent app
installation for unknown ids; OpenClaw only activates marketplace plugins
with `plugin/install` and then refreshes inventory.

### Environment isolation

For local stdio app-server launches, OpenClaw sets `CODEX_HOME` to a
per-agent directory so Codex config, auth/account files, plugin cache/data,
and native thread state do not read or write the operator's personal
`~/.codex` by default. OpenClaw preserves the normal process `HOME`;
Codex-run subprocesses can still find user-home config and tokens, and
Codex may discover shared `$HOME/.agents/skills` and
`$HOME/.agents/plugins/marketplace.json` entries. With
`appServer.homeScope: "user"`, OpenClaw instead uses the native user Codex
home and its existing account without injecting an OpenClaw auth profile.

If a deployment needs additional environment isolation, add those
variables to `appServer.clearEnv`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
        },
      },
    },
  },
}
```

`appServer.clearEnv` only affects the spawned Codex app-server child
process. OpenClaw removes `CODEX_HOME` and `HOME` from this list during
local launch normalization: `CODEX_HOME` stays pointed at the selected
agent or user scope, and `HOME` stays inherited so subprocesses can use
normal user-home state.

### Dynamic tools and web search

Codex dynamic tools default to `searchable` loading. OpenClaw does not
expose dynamic tools that duplicate Codex-native workspace operations:
`read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `update_plan`,
`tool_call`, `tool_describe`, `tool_search`, and `tool_search_code`. Most
remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, and `heartbeat_respond`, are available through
Codex tool search under the `openclaw` namespace, keeping the initial model
context smaller.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool, use the `openclaw_direct` namespace instead. Codex treats that namespace
as `DirectModelOnly`, so those tools stay directly model-visible in normal and
code-mode-only threads rather than crossing nested Code Mode `tools.*` calls.

Web search uses Codex's hosted `web_search` tool by default when search is
enabled and no managed provider is selected. Native hosted search and
OpenClaw's managed `web_search` dynamic tool are mutually exclusive so
managed search cannot bypass native domain restrictions. OpenClaw uses the
managed tool when hosted search is unavailable, explicitly disabled, or
replaced by a selected managed provider. OpenClaw keeps Codex's standalone
`web.run` extension disabled because production app-server traffic rejects
its user-defined `web` namespace. `tools.web.search.enabled: false`
disables both paths, as do tool-disabled LLM-only runs. Codex treats
`"cached"` as a preference and resolves it to live external access for
unrestricted app-server turns. Automatic managed fallback fails closed when
native `allowedDomains` are set so the allowlist cannot be bypassed.
Persistent effective search-policy changes rotate the bound Codex thread
before the next turn; transient per-turn restrictions use a temporary
restricted thread and preserve the existing binding for later resume.

`sessions_yield` and message-tool-only source replies stay direct because
those are turn-control contracts. `sessions_spawn` stays searchable so
Codex's native `spawn_agent` remains the primary Codex subagent surface,
while explicit OpenClaw or ACP delegation is still available through the
`openclaw` dynamic tool namespace. Heartbeat collaboration instructions
tell Codex to search for `heartbeat_respond` before ending a heartbeat turn
when the tool is not already loaded.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when
debugging the full tool payload.

### Config fields

Supported top-level Codex plugin fields:

| Field                      | Default        | Meaning                                                                                  |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `codexDynamicToolsLoading` | `"searchable"` | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context. |
| `codexDynamicToolsExclude` | `[]`           | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.              |
| `codexPlugins`             | disabled       | Native Codex plugin/app support for migrated source-installed curated plugins.           |
| `supervision`              | disabled       | Non-archived native-session catalog, local branch continuation, and agent-tool policy.   |

Supported `appServer` fields:

| Field                                         | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                                   | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                |
| `homeScope`                                   | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.     |
| `command`                                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                                                                                                                                                                                                                                                                                    |
| `args`                                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                  |
| `url`                                         | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                          |
| `authToken`                                   | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                              |
| `headers`                                     | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                               |
| `clearEnv`                                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. OpenClaw keeps the selected `CODEX_HOME` and inherited `HOME` for local launches.                                                                                                                                                                           |
| `codeModeOnly`                                | `false`                                                | Opt into Codex's code-mode-only tool surface. Ordinary OpenClaw dynamic tools remain available through nested `tools.*` calls; `openclaw_direct` tools stay directly model-visible.                                                                                                                                                                                                             |
| `remoteWorkspaceRoot`                         | unset                                                  | Remote Codex app-server workspace root. When set, OpenClaw infers the local workspace root from the resolved OpenClaw workspace, preserves the current cwd suffix under this remote root, and sends only the final app-server cwd to Codex. If the cwd is outside the resolved OpenClaw workspace root, OpenClaw fails closed instead of sending a gateway-local path to the remote app-server. |
| `requestTimeoutMs`                            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                     |
| `turnCompletionIdleTimeoutMs`                 | `60000`                                                | Quiet window after Codex accepts a turn or after a turn-scoped app-server request while OpenClaw waits for `turn/completed`.                                                                                                                                                                                                                                                                    |
| `postToolRawAssistantCompletionIdleTimeoutMs` | `300000`                                               | Completion-idle and progress guard used after a tool handoff, native tool completion, post-tool raw assistant progress, raw reasoning completion, or reasoning progress while OpenClaw waits for `turn/completed`. Use this for trusted or heavy workloads where post-tool synthesis can legitimately stay quiet longer than the final assistant release budget.                                |
| `mode`                                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution. Local stdio requirements that omit `danger-full-access`, `never` approval, or the `user` reviewer make the implicit default guardian.                                                                                                                                                                                                           |
| `approvalPolicy`                              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start/resume/turn. Guardian defaults prefer `"on-request"` when allowed.                                                                                                                                                                                                                                                                            |
| `sandbox`                                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start/resume. Guardian defaults prefer `"workspace-write"` when allowed, otherwise `"read-only"`. When an OpenClaw sandbox is active, `danger-full-access` turns use Codex `workspace-write` with network access derived from the OpenClaw sandbox egress setting.                                                                                     |
| `approvalsReviewer`                           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed, otherwise `guardian_subagent` or `user`. `guardian_subagent` remains a legacy alias.                                                                                                                                                                                                                              |
| `serviceTier`                                 | unset                                                  | Optional Codex app-server service tier. `"priority"` enables fast-mode routing, `"flex"` requests flex processing, `null` clears the override, and legacy `"fast"` is accepted as `"priority"`.                                                                                                                                                                                                 |
| `networkProxy`                                | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                             |
| `experimental.sandboxExecServer`              | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                            |

`appServer.networkProxy` is explicit because it changes the Codex sandbox
contract. When enabled, OpenClaw also sets `features.network_proxy.enabled`
and `default_permissions` in the Codex thread config so the generated
permission profile can start Codex managed networking. By default, OpenClaw
generates a collision-resistant `openclaw-network-<fingerprint>` profile
name from the profile body; use `profileName` only when a stable local name
is required.

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            sandbox: "workspace-write",
            networkProxy: {
              enabled: true,
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              unixSockets: {
                "/tmp/proxy.sock": "allow",
                "/tmp/blocked.sock": "none",
              },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    },
  },
}
```

If the normal app-server runtime would be `danger-full-access`, enabling
`networkProxy` uses workspace-style filesystem access for the generated
permission profile: Codex managed network enforcement is sandboxed
networking, so a full-access profile would not protect outbound traffic.
Domain entries use `allow` or `deny`; Unix socket entries use Codex's
`allow` or `none` values.

### Dynamic tool call timeouts

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`: Codex `item/tool/call` requests use a 90
second OpenClaw watchdog by default. A positive per-call `timeoutMs`
argument extends or shortens that specific tool budget, capped at 600000 ms.
The `image_generate` tool uses `agents.defaults.imageGenerationModel.timeoutMs`
when the tool call does not provide its own timeout, or a 120 second
image-generation default otherwise. The media-understanding `image` tool
uses `tools.media.image.timeoutSeconds` or its 60 second media default; for
image understanding, that timeout applies to the request itself and is not
reduced by earlier preparation work. On timeout, OpenClaw aborts the tool
signal where supported and returns a failed dynamic-tool response to Codex
so the turn can continue instead of leaving the session in `processing`.
This watchdog is the outer dynamic `item/tool/call` budget; provider-specific
request timeouts run inside that call and keep their own timeout semantics.

After Codex accepts a turn, and after OpenClaw responds to a turn-scoped
app-server request, the harness expects Codex to make current-turn progress
and eventually finish the native turn with `turn/completed`. If the
app-server goes quiet for `appServer.turnCompletionIdleTimeoutMs`, OpenClaw
best-effort interrupts the Codex turn, records a diagnostic timeout, and
releases the OpenClaw session lane so follow-up chat messages are not
queued behind a stale native turn. Most non-terminal notifications for the
same turn disarm that short watchdog because Codex has proven the turn is
still alive.

Tool handoffs use a longer post-tool idle budget: after OpenClaw returns an
`item/tool/call` response, after native tool items such as
`commandExecution` complete, after raw `custom_tool_call_output`
completions, and after post-tool raw assistant progress, raw reasoning
completions, or reasoning progress. The guard uses
`appServer.postToolRawAssistantCompletionIdleTimeoutMs` when configured and
defaults to five minutes otherwise; that same budget also extends the
progress watchdog for the silent synthesis window before Codex emits the
next current-turn event. Global app-server notifications, such as
rate-limit updates, do not reset turn-idle progress. Reasoning completions,
commentary `agentMessage` completions, and pre-tool raw reasoning or
assistant progress can be followed by an automatic final reply, so they use
the post-progress reply guard instead of releasing the session lane
immediately.

Only final/non-commentary completed `agentMessage` items and pre-tool raw
assistant completions arm the assistant-output release: if Codex then goes
quiet without `turn/completed`, OpenClaw best-effort interrupts the native
turn and releases the session lane. If another turn watch wins that release
race, OpenClaw still accepts the completed final assistant item once no
native request, item, or dynamic tool completion remains active and the
assistant-output release still belongs to the latest completed item, with
no later item completion. This can preserve the final answer after
completed tool work without replaying the turn. Partial assistant deltas,
stale earlier replies, and empty later completions do not qualify.

Replay-safe stdio app-server failures, including turn-completion idle
timeouts without assistant, tool, active-item, or side-effect evidence, are
retried once on a fresh app-server attempt. Unsafe timeouts still retire the
stuck app-server client and release the OpenClaw session lane; they also
clear the stale native thread binding instead of being replayed
automatically. Completion-watch timeouts surface Codex-specific timeout
text: replay-safe cases say the response may be incomplete, while unsafe
cases tell the user to verify current state before retrying. Public timeout
diagnostics include structural fields such as the last app-server
notification method, raw assistant response item id/type/role, active
request/item counts, and armed watch state; when the last notification is a
raw assistant response item, they also include a bounded assistant text
preview. They do not include raw prompt or tool content.

### Local testing env overrides

- `OPENCLAW_CODEX_APP_SERVER_BIN` bypasses the managed binary when
  `appServer.command` is unset.
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config
is preferred for repeatable deployments because it keeps the plugin
behavior in the same reviewed file as the rest of the Codex harness setup.

## Native Codex plugins

Native Codex plugin support uses Codex app-server's own app and plugin
capabilities in the same Codex thread as the OpenClaw harness turn. OpenClaw
does not translate Codex plugins into synthetic `codex_plugin_*` OpenClaw
dynamic tools.

`codexPlugins` affects only sessions that select the native Codex harness.
It has no effect on built-in harness runs, normal OpenAI provider runs, ACP
conversation bindings, or other harnesses.

Minimal migrated config:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    },
  },
}
```

Thread app config is computed when OpenClaw establishes a Codex harness
session or replaces a stale Codex thread binding; it is not recomputed on
every turn. After changing `codexPlugins`, use `/new`, `/reset`, or restart
the gateway so future Codex harness sessions start with the updated app
set.

For migration eligibility, app inventory, destructive action policy,
elicitations, and native plugin diagnostics, see
[Native Codex plugins](/plugins/codex-native-plugins).

OpenAI-side app and plugin access is controlled by the signed-in Codex
account and, for Business and Enterprise/Edu workspaces, workspace app
controls. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
for OpenAI's account and workspace-control overview.

## Computer Use

Computer Use has its own setup guide:
[Codex Computer Use](/plugins/codex-computer-use).

Short version: OpenClaw does not vendor the desktop-control app or execute
desktop actions itself. It prepares Codex app-server, verifies that the
`computer-use` MCP server is available, and then lets Codex own the native
MCP tool calls during Codex-mode turns.

## Runtime boundaries

The Codex harness changes the low-level embedded agent executor only.

- OpenClaw dynamic tools are supported. Codex asks OpenClaw to execute
  those tools, so OpenClaw remains in the execution path.
- Codex-native shell, patch, MCP, and native app tools are owned by Codex.
  OpenClaw can observe or block selected native events through the
  supported relay, but it does not rewrite native tool arguments.
- Codex owns native compaction. OpenClaw keeps a transcript mirror for
  channel history, search, `/new`, `/reset`, and future model or harness
  switching, but does not replace Codex compaction with an OpenClaw or
  context-engine summarizer.
- Media generation, media understanding, TTS, approvals, and messaging-tool
  output continue through the matching OpenClaw provider/model settings.
- `tool_result_persist` applies to OpenClaw-owned transcript tool results,
  not Codex-native tool result records.

For hook layers, supported V1 surfaces, native permission handling, queue
steering, Codex feedback upload mechanics, and compaction details, see
[Codex harness runtime](/plugins/codex-harness-runtime).

## Troubleshooting

**Codex does not appear as a normal `/model` provider:** expected for new
configs. Select an `openai/gpt-*` model, enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses the built-in harness instead of Codex:** confirm the effective
route is an exact official HTTPS Platform Responses or ChatGPT Responses route,
has no authored request override, and that the Codex plugin is installed and
enabled. The `openai/gpt-*` prefix alone is not enough. For strict proof while
testing, set provider or model `agentRuntime.id: "codex"`; forced Codex fails
instead of falling back when the route or harness is incompatible.

**OpenAI Codex runtime falls back to the API-key path:** collect a redacted
gateway excerpt that shows the model, runtime, selected provider, and
failure. Ask affected collaborators to run this read-only command on their
OpenClaw host:

```bash
(
  pattern='openai/gpt-5\.[45]|openai[-]codex|agentRuntime(\.id)?|harnessRuntime|Runtime: OpenAI Codex|legacy OpenAI Codex prefix|resolveSelectedOpenAIRuntimeProvider|candidateProvider[": ]+openai|status[": ]+401|Incorrect API key|No API key|api-key path|API-key path|OAuth'

  if ls /tmp/openclaw/openclaw-*.log >/dev/null 2>&1; then
    grep -E -i -n "$pattern" /tmp/openclaw/openclaw-*.log 2>/dev/null || true
  else
    journalctl --user -u openclaw-gateway --since today --no-pager 2>/dev/null \
      | grep -E -i "$pattern" || true
  fi
) | sed -E \
    -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(api[_ -]?key[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/(OPENAI_API_KEY[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/sk-[A-Za-z0-9_-]{12,}/sk-[REDACTED]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[EMAIL-REDACTED]/g' \
  | tail -200
```

Useful excerpts usually include `openai/gpt-5.6-sol` or `openai/gpt-5.6-luna`,
`Runtime: OpenAI Codex`, `agentRuntime.id` or `harnessRuntime`,
`candidateProvider: "openai"`, and a `401`, `Incorrect API key`, or
`No API key` result. A corrected run should show the OpenAI OAuth path
instead of a plain OpenAI API-key failure.

**Legacy Codex model refs config remains:** run `openclaw doctor --fix`.
Doctor rewrites legacy model refs to `openai/*`, removes stale session and
whole-agent runtime pins, and preserves existing auth-profile overrides.

**The app-server is rejected:** use Codex app-server `0.143.0` or newer.
Same-version prereleases or build-suffixed versions such as
`0.143.0-alpha.2` or `0.143.0+custom` are rejected because OpenClaw tests
the stable `0.143.0` protocol floor.

**`/codex status` cannot connect:** check that the `codex` plugin
is enabled, that `plugins.allow` includes it when an allowlist is
configured, and that any custom `appServer.command`, `url`, `authToken`, or
headers are valid.

**Model discovery is slow:** lower
`plugins.entries.codex.config.discovery.timeoutMs` or disable discovery.
See [Codex harness reference](/plugins/codex-harness-reference#model-discovery).

**WebSocket transport fails immediately:** check `appServer.url`,
`authToken`, headers, and that the remote app-server speaks the same Codex
app-server protocol version.

**Native shell or patch tools are blocked with `Native hook relay
unavailable`:** the Codex thread is still trying to use a native hook relay
id that OpenClaw no longer has registered. This is a native Codex hook
transport problem, not an ACP backend, provider, GitHub, or shell-command
failure. Start a fresh session in the affected chat with `/new` or `/reset`,
then retry a harmless command. If that works once but the next native tool
call fails again, treat `/new` as a temporary workaround only: copy the
prompt into a fresh session after restarting the Codex app-server or
OpenClaw Gateway so old threads are dropped and native hook registrations
are recreated.

**A non-Codex model uses the built-in harness:** expected unless provider
or model runtime policy routes it to another harness. Plain non-OpenAI
provider refs stay on their normal provider path in `auto` mode.

**Computer Use is installed but tools do not run:** check
`/codex computer-use status` from a fresh session. If a tool reports
`Native hook relay unavailable`, use the native hook relay recovery above.
See [Codex Computer Use](/plugins/codex-computer-use#troubleshooting).

## Related

- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [OpenAI Codex help](https://help.openai.com/en/collections/14937394-codex)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Plugin hooks](/plugins/hooks)
- [Diagnostics export](/gateway/diagnostics)
- [Status](/cli/status)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
