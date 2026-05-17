---
summary: "Run OpenClaw embedded agent turns through the bundled Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the bundled Codex app-server harness
  - You need Codex harness config examples
  - You want Codex-only deployments to fail instead of falling back to PI
---

The bundled `codex` plugin lets OpenClaw run embedded OpenAI agent turns
through Codex app-server instead of the built-in PI harness.

Use the Codex harness when you want Codex to own the low-level agent session:
native thread resume, native tool continuation, native compaction, and
app-server execution. OpenClaw still owns chat channels, session files, model
selection, OpenClaw dynamic tools, approvals, media delivery, and the visible
transcript mirror.

The normal setup uses canonical OpenAI model refs such as `openai/gpt-5.5`.
Do not configure `openai-codex/gpt-*` model refs. Put OpenAI agent auth order
under `auth.order.openai`; older `openai-codex:*` profiles and
`auth.order.openai-codex` entries remain supported for existing installs.

OpenClaw starts Codex app-server threads with Codex native code mode and
code-mode-only enabled. That keeps deferred/searchable OpenClaw dynamic tools
inside Codex's own code execution and tool-search surface instead of adding a
PI-style tool-search wrapper on top of Codex.

For the broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes). The short version is:
`openai/gpt-5.5` is the model ref, `codex` is the runtime, and Telegram,
Discord, Slack, or another channel remains the communication surface.

## Requirements

- OpenClaw with the bundled `codex` plugin available.
- If your config uses `plugins.allow`, include `codex`.
- Codex app-server `0.125.0` or newer. The bundled plugin manages a compatible
  Codex app-server binary by default, so local `codex` commands on `PATH` do not
  affect normal harness startup.
- Codex auth available through `openclaw models auth login --provider openai-codex`,
  an app-server account in the agent's Codex home, or an explicit Codex API-key
  auth profile.

For auth precedence, environment isolation, custom app-server commands, model
discovery, and all config fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Quickstart

Most users who want Codex in OpenClaw want this path: sign in with a
ChatGPT/Codex subscription, enable the bundled `codex` plugin, and use a
canonical `openai/gpt-*` model ref.

Sign in with Codex OAuth:

```bash
openclaw models auth login --provider openai-codex
```

Enable the bundled `codex` plugin and select an OpenAI agent model:

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
      model: "openai/gpt-5.5",
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

Restart the gateway after changing plugin config. If an existing chat already
has a session, use `/new` or `/reset` before testing runtime changes so the next
turn resolves the harness from current config.

## Configuration

The quickstart config is the minimum viable Codex harness config. Set Codex
harness options in OpenClaw config, and use the CLI only for Codex auth:

| Need                                   | Set                                                                              | Where                              |
| -------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| Enable the harness                     | `plugins.entries.codex.enabled: true`                                            | OpenClaw config                    |
| Keep an allowlisted plugin install     | Include `codex` in `plugins.allow`                                               | OpenClaw config                    |
| Route OpenAI agent turns through Codex | `agents.defaults.model` or `agents.list[].model` as `openai/gpt-*`               | OpenClaw agent config              |
| Sign in with Codex OAuth               | `openclaw models auth login --provider openai-codex`                             | CLI auth profile                   |
| Add API-key backup for Codex runs      | `openai:*` API-key profile listed after subscription auth in `auth.order.openai` | CLI auth profile + OpenClaw config |
| Fail closed when Codex is unavailable  | Provider or model `agentRuntime.id: "codex"`                                     | OpenClaw model/provider config     |
| Use direct OpenAI API traffic          | Provider or model `agentRuntime.id: "pi"` with normal OpenAI auth                | OpenClaw model/provider config     |
| Tune app-server behavior               | `plugins.entries.codex.config.appServer.*`                                       | Codex plugin config                |
| Enable native Codex plugin apps        | `plugins.entries.codex.config.codexPlugins.*`                                    | Codex plugin config                |
| Enable Codex Computer Use              | `plugins.entries.codex.config.computerUse.*`                                     | Codex plugin config                |

Use `openai/gpt-*` model refs for Codex-backed OpenAI agent turns. Prefer
`auth.order.openai` for subscription-first/API-key-backup ordering. Existing
`openai-codex:*` auth profiles and `auth.order.openai-codex` remain valid, but
do not write new `openai-codex/gpt-*` model refs.

Do not set `compaction.model` or `compaction.provider` on Codex-backed agents
unless a selected context engine owns compaction. Without an owning context
engine, Codex compacts through its native app-server thread state, so OpenClaw
ignores those local summarizer overrides at runtime and `openclaw doctor --fix`
removes them when the agent uses Codex.

Lossless remains supported as a context engine. Configure it through
`plugins.slots.contextEngine: "lossless-claw"` and
`plugins.entries.lossless-claw.config.summaryModel`, not through
`agents.defaults.compaction.provider`. `openclaw doctor --fix` migrates the old
`compaction.provider: "lossless-claw"` shape to the Lossless context-engine slot
when Codex is the active runtime.

When the active context engine reports `ownsCompaction: true`, `/compact` runs
that engine's compaction lifecycle and invalidates the bound Codex app-server
thread. The next Codex turn starts a fresh backend thread and rehydrates it from
the context engine instead of layering Codex native compaction on top of the
engine-owned semantic summary.

```json5
{
  auth: {
    order: {
      openai: ["openai-codex:user@example.com", "openai:api-key-backup"],
    },
  },
}
```

In that shape, both profiles still run through Codex for `openai/gpt-*` agent
turns. The API key is only an auth fallback, not a request to switch to PI or
plain OpenAI Responses.

The rest of this page covers common variants users must choose between:
deployment shape, fail-closed routing, guardian approval policy, native Codex
plugins, and Computer Use. For full option lists, defaults, enums, discovery,
environment isolation, timeouts, and app-server transport fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Verify Codex runtime

Use `/status` in the chat where you expect Codex. A Codex-backed OpenAI agent
turn shows:

```text
Runtime: OpenAI Codex
```

Then check Codex app-server state:

```text
/codex status
/codex models
```

`/codex status` reports app-server connectivity, account, rate limits, MCP
servers, and skills. `/codex models` lists the live Codex app-server catalog for
the harness and account. If `/status` is surprising, see
[Troubleshooting](#troubleshooting).

## Routing and model selection

Keep provider refs and runtime policy separate:

- Use `openai/gpt-*` for OpenAI agent turns through Codex.
- Do not use `openai-codex/gpt-*` in config. Run `openclaw doctor --fix` to
  repair legacy refs and stale session route pins.
- `agentRuntime.id: "codex"` is optional for normal OpenAI auto mode, but useful
  when a deployment should fail closed if Codex is unavailable.
- `agentRuntime.id: "pi"` opts a provider or model into direct PI behavior when
  that is intentional.
- `/codex ...` controls native Codex app-server conversations from chat.
- ACP/acpx is a separate external harness path. Use it only when the user asks
  for ACP/acpx or an external harness adapter.

Common command routing:

| User intent                                           | Use                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Attach the current chat                               | `/codex bind [--cwd <path>]`                                                                          |
| Resume an existing Codex thread                       | `/codex resume <thread-id>`                                                                           |
| List or filter Codex threads                          | `/codex threads [filter]`                                                                             |
| Attach an existing Codex CLI session on a paired node | `/codex sessions --host <node> [filter]`, then `/codex resume <session-id> --host <node> --bind here` |
| Send Codex feedback only                              | `/codex diagnostics [note]`                                                                           |
| Start an ACP/acpx task                                | ACP/acpx session commands, not `/codex`                                                               |

| Use case                                             | Configure                                                        | Verify                                  | Notes                              |
| ---------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| ChatGPT/Codex subscription with native Codex runtime | `openai/gpt-*` plus enabled `codex` plugin                       | `/status` shows `Runtime: OpenAI Codex` | Recommended path                   |
| Fail closed if Codex is unavailable                  | Provider or model `agentRuntime.id: "codex"`                     | Turn fails instead of PI fallback       | Use for Codex-only deployments     |
| Direct OpenAI API-key traffic through PI             | Provider or model `agentRuntime.id: "pi"` and normal OpenAI auth | `/status` shows PI runtime              | Use only when PI is intentional    |
| Legacy config                                        | `openai-codex/gpt-*`                                             | `openclaw doctor --fix` rewrites it     | Do not write new config this way   |
| ACP/acpx Codex adapter                               | ACP `sessions_spawn({ runtime: "acp" })`                         | ACP task/session status                 | Separate from native Codex harness |

`agents.defaults.imageModel` follows the same prefix split. Use `openai/gpt-*`
for the normal OpenAI route and `codex/gpt-*` only when image understanding
should run through a bounded Codex app-server turn. Do not use
`openai-codex/gpt-*`; doctor rewrites that legacy prefix to `openai/gpt-*`.

## Deployment patterns

### Basic Codex deployment

Use the quickstart config when all OpenAI agent turns should use Codex by
default.

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
      model: "openai/gpt-5.5",
    },
  },
}
```

### Mixed provider deployment

This shape keeps Claude as the default agent and adds a named Codex agent:

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
        model: "openai/gpt-5.5",
      },
    ],
  },
}
```

With this config, the `main` agent uses its normal provider path and the
`codex` agent uses Codex app-server.

### Fail-closed Codex deployment

For OpenAI agent turns, `openai/gpt-*` already resolves to Codex when the
bundled plugin is available. Add explicit runtime policy when you want a written
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
      model: "openai/gpt-5.5",
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

With Codex forced, OpenClaw fails early if the Codex plugin is disabled, the
app-server is too old, or the app-server cannot start.

## App-server policy

By default, the plugin starts OpenClaw's managed Codex binary locally with stdio
transport. Set `appServer.command` only when you intentionally want to run a
different executable. Use WebSocket transport only when an app-server is already
running elsewhere:

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

Local stdio app-server sessions default to the trusted local operator posture:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. If local Codex requirements disallow that
implicit YOLO posture, OpenClaw selects allowed guardian permissions instead.
When an OpenClaw sandbox is active for the session, OpenClaw narrows Codex
`danger-full-access` to Codex `workspace-write` so native Codex code-mode turns
stay inside the sandboxed workspace.

Use guardian mode when you want Codex native auto-review before sandbox escapes
or extra permissions:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            mode: "guardian",
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

Guardian mode expands to Codex app-server approvals, usually
`approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`, and
`sandbox: "workspace-write"` when the local requirements allow those values.

For every app-server field, auth order, environment isolation, discovery, and
timeout behavior, see [Codex harness reference](/plugins/codex-harness-reference).

## Commands and diagnostics

The bundled plugin registers `/codex` as a slash command on any channel that
supports OpenClaw text commands.

Common forms:

- `/codex status` checks app-server connectivity, models, account, rate limits,
  MCP servers, and skills.
- `/codex models` lists live Codex app-server models.
- `/codex threads [filter]` lists recent Codex app-server threads.
- `/codex resume <thread-id>` attaches the current OpenClaw session to an
  existing Codex thread.
- `/codex compact` asks Codex app-server to compact the attached thread.
- `/codex review` starts Codex native review for the attached thread.
- `/codex diagnostics [note]` asks before sending Codex feedback for the
  attached thread.
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.

For most support reports, start with `/diagnostics [note]` in the conversation
where the bug happened. It creates one Gateway diagnostics report and, for Codex
harness sessions, asks for approval to send the relevant Codex feedback bundle.
See [Diagnostics export](/gateway/diagnostics) for the privacy model and group
chat behavior.

Use `/codex diagnostics [note]` only when you specifically want the Codex
feedback upload for the currently attached thread without the full Gateway
diagnostics bundle.

### Inspect Codex threads locally

The fastest way to inspect a bad Codex run is often to open the native Codex
thread directly:

```bash
codex resume <thread-id>
```

Get the thread id from the completed `/diagnostics` reply, `/codex binding`, or
`/codex threads [filter]`.

For upload mechanics and runtime-level diagnostics boundaries, see
[Codex harness runtime](/plugins/codex-harness-runtime#codex-feedback-upload).

Auth is selected in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Existing `openai-codex:*` profile ids remain valid.
2. The app-server's existing account in that agent's Codex home.
3. For local stdio app-server launches only, `CODEX_API_KEY`, then
   `OPENAI_API_KEY`, when no app-server account is present and OpenAI auth is
   still required.

When OpenClaw sees a ChatGPT subscription-style Codex auth profile, it removes
`CODEX_API_KEY` and `OPENAI_API_KEY` from the spawned Codex child process. That
keeps Gateway-level API keys available for embeddings or direct OpenAI models
without making native Codex app-server turns bill through the API by accident.
Explicit Codex API-key profiles and local stdio env-key fallback use app-server
login instead of inherited child-process env. WebSocket app-server connections
do not receive Gateway env API-key fallback; use an explicit auth profile or the
remote app-server's own account.

If a subscription profile hits a Codex usage limit, OpenClaw records the reset
time when Codex reports one and tries the next ordered auth profile for the same
Codex run. When the reset time passes, the subscription profile becomes eligible
again without changing the selected `openai/gpt-*` model or Codex runtime.

For local stdio app-server launches, OpenClaw sets `CODEX_HOME` to a per-agent
directory so Codex config, auth/account files, plugin cache/data, and native
thread state do not read or write the operator's personal `~/.codex` by
default. OpenClaw preserves the normal process `HOME`; Codex-run subprocesses
can still find user-home config and tokens, and Codex may discover shared
`$HOME/.agents/skills` and `$HOME/.agents/plugins/marketplace.json` entries.

If a deployment needs additional environment isolation, add those variables to
`appServer.clearEnv`:

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

`appServer.clearEnv` only affects the spawned Codex app-server child process.
OpenClaw removes `CODEX_HOME` and `HOME` from this list during local launch
normalization: `CODEX_HOME` stays per-agent, and `HOME` stays inherited so
subprocesses can use normal user-home state.

Codex dynamic tools default to `searchable` loading. OpenClaw does not expose
dynamic tools that duplicate Codex-native workspace operations: `read`, `write`,
`edit`, `apply_patch`, `exec`, `process`, and `update_plan`. Remaining OpenClaw
integration tools such as messaging, sessions, media, cron, browser, nodes,
gateway, `heartbeat_respond`, and `web_search` are available through Codex tool
search under the `openclaw` namespace, keeping the initial model context
smaller.
`sessions_yield` and message-tool-only source replies stay direct because those
are turn-control contracts. Heartbeat collaboration instructions tell Codex to
search for `heartbeat_respond` before ending a heartbeat turn when the tool is
not already loaded.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom Codex
app-server that cannot search deferred dynamic tools or when debugging the full
tool payload.

Supported top-level Codex plugin fields:

| Field                      | Default        | Meaning                                                                                  |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `codexDynamicToolsLoading` | `"searchable"` | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context. |
| `codexDynamicToolsExclude` | `[]`           | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.              |
| `codexPlugins`             | disabled       | Native Codex plugin/app support for migrated source-installed curated plugins.           |

Supported `appServer` fields:

| Field                         | Default                                                | Meaning                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                   | `"stdio"`                                              | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                                                                                                                                                |
| `command`                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                                                                                                                            |
| `args`                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                          |
| `url`                         | unset                                                  | WebSocket app-server URL.                                                                                                                                                                                                               |
| `authToken`                   | unset                                                  | Bearer token for WebSocket transport.                                                                                                                                                                                                   |
| `headers`                     | `{}`                                                   | Extra WebSocket headers.                                                                                                                                                                                                                |
| `clearEnv`                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. OpenClaw keeps per-agent `CODEX_HOME` and inherited `HOME` for local launches.                      |
| `requestTimeoutMs`            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                             |
| `turnCompletionIdleTimeoutMs` | `60000`                                                | Quiet window after Codex accepts a turn or after a turn-scoped app-server request while OpenClaw waits for `turn/completed`. Raise this for slow post-tool or status-only synthesis phases.                                             |
| `mode`                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution. Local stdio requirements that omit `danger-full-access`, `never` approval, or the `user` reviewer make the implicit default guardian.                                                   |
| `approvalPolicy`              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start/resume/turn. Guardian defaults prefer `"on-request"` when allowed.                                                                                                                    |
| `sandbox`                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start/resume. Guardian defaults prefer `"workspace-write"` when allowed, otherwise `"read-only"`. When an OpenClaw sandbox is active, `danger-full-access` is narrowed to `"workspace-write"`. |
| `approvalsReviewer`           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed, otherwise `guardian_subagent` or `user`. `guardian_subagent` remains a legacy alias.                                                                      |
| `serviceTier`                 | unset                                                  | Optional Codex app-server service tier. `"priority"` enables fast-mode routing, `"flex"` requests flex processing, `null` clears the override, and legacy `"fast"` is accepted as `"priority"`.                                         |

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`: Codex `item/tool/call` requests use a 30 second
OpenClaw watchdog by default. A positive per-call `timeoutMs` argument extends
or shortens that specific tool budget. The `image_generate` tool also uses
`agents.defaults.imageGenerationModel.timeoutMs` when the tool call does not
provide its own timeout, and the media-understanding `image` tool uses
`tools.media.image.timeoutSeconds` or its 60 second media default. Dynamic tool
budgets are capped at 600000 ms. On timeout, OpenClaw aborts the tool signal
where supported and returns a failed dynamic-tool response to Codex so the turn
can continue instead of leaving the session in `processing`.

After Codex accepts a turn, and after OpenClaw responds to a turn-scoped
app-server request, the harness expects Codex to make current-turn progress and
eventually finish the native turn with `turn/completed`. If the app-server goes
quiet for `appServer.turnCompletionIdleTimeoutMs`, OpenClaw best-effort
interrupts the Codex turn, records a diagnostic timeout, and releases the
OpenClaw session lane so follow-up chat messages are not queued behind a stale
native turn. Most non-terminal notifications for the same turn disarm that short
watchdog because Codex has proven the turn is still alive; raw
`custom_tool_call_output` completions keep the short post-tool watchdog armed
because they are the turn-scoped tool-result handoff. Global app-server
notifications, such as rate-limit updates, do not reset turn-idle progress.
Completed `agentMessage` items and pre-tool raw assistant
`rawResponseItem/completed` items arm the assistant-output release: if Codex then
goes quiet without `turn/completed`, OpenClaw best-effort interrupts the native
turn and releases the session lane. Post-tool raw assistant progress keeps
waiting for `turn/completed` or the terminal watchdog. Timeout diagnostics
include the last app-server notification method and, for raw assistant response
items, the item type, role, id, and a bounded assistant text preview.

Environment overrides remain available for local testing:

- `OPENCLAW_CODEX_APP_SERVER_BIN`
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_BIN` bypasses the managed binary when
`appServer.command` is unset.

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config is
preferred for repeatable deployments because it keeps the plugin behavior in the
same reviewed file as the rest of the Codex harness setup.

## Native Codex plugins

Native Codex plugin support uses Codex app-server's own app and plugin
capabilities in the same Codex thread as the OpenClaw harness turn. OpenClaw
does not translate Codex plugins into synthetic `codex_plugin_*` OpenClaw
dynamic tools.

`codexPlugins` affects only sessions that select the native Codex harness. It
has no effect on PI runs, normal OpenAI provider runs, ACP conversation
bindings, or other harnesses.

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

Thread app config is computed when OpenClaw establishes a Codex harness session
or replaces a stale Codex thread binding. It is not recomputed on every turn.
After changing `codexPlugins`, use `/new`, `/reset`, or restart the gateway so
future Codex harness sessions start with the updated app set.

For migration eligibility, app inventory, destructive action policy,
elicitations, and native plugin diagnostics, see
[Native Codex plugins](/plugins/codex-native-plugins).

## Computer Use

Computer Use is covered in its own setup guide:
[Codex Computer Use](/plugins/codex-computer-use).

The short version: OpenClaw does not vendor the desktop-control app or execute
desktop actions itself. It prepares Codex app-server, verifies that the
`computer-use` MCP server is available, and then lets Codex own the native MCP
tool calls during Codex-mode turns.

## Runtime boundaries

The Codex harness changes the low-level embedded agent executor only.

- OpenClaw dynamic tools are supported. Codex asks OpenClaw to execute those
  tools, so OpenClaw remains in the execution path.
- Codex-native shell, patch, MCP, and native app tools are owned by Codex.
  OpenClaw can observe or block selected native events through the supported
  relay, but it does not rewrite native tool arguments.
- Codex owns native compaction unless the active OpenClaw context engine
  declares `ownsCompaction: true`. OpenClaw keeps a transcript mirror for
  channel history, search, `/new`, `/reset`, and future model or harness
  switching.
- Media generation, media understanding, TTS, approvals, and messaging-tool
  output continue through the matching OpenClaw provider/model settings.
- `tool_result_persist` applies to OpenClaw-owned transcript tool results, not
  Codex-native tool result records.

For hook layers, supported V1 surfaces, native permission handling, queue
steering, Codex feedback upload mechanics, and compaction details, see
[Codex harness runtime](/plugins/codex-harness-runtime).

## Troubleshooting

**Codex does not appear as a normal `/model` provider:** that is expected for
new configs. Select an `openai/gpt-*` model, enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses PI instead of Codex:** make sure the model ref is
`openai/gpt-*` on the official OpenAI provider and that the Codex plugin is
installed and enabled. If you need strict proof while testing, set provider or
model `agentRuntime.id: "codex"`. A forced Codex runtime fails instead of
falling back to PI.

**OpenAI Codex runtime falls back to the API-key path:** collect a redacted
gateway excerpt that shows the model, runtime, selected provider, and failure.
Ask affected collaborators to run this read-only command on their OpenClaw host:

```bash
(
  pattern='openai/gpt-5\.[45]|agentRuntime(\.id)?|harnessRuntime|Runtime: OpenAI Codex|openai-codex|resolveSelectedOpenAIPiRuntimeProvider|candidateProvider[": ]+openai|status[": ]+401|Incorrect API key|No API key|api-key path|API-key path|OAuth'

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

Useful excerpts usually include `openai/gpt-5.5` or `openai/gpt-5.4`,
`Runtime: OpenAI Codex`, `agentRuntime.id` or `harnessRuntime`,
`candidateProvider: "openai"`, and a `401`, `Incorrect API key`, or
`No API key` result. A corrected run should show the `openai-codex` OAuth
path instead of a plain OpenAI API-key failure.

**Legacy `openai-codex/*` config remains:** run `openclaw doctor --fix`.
Doctor rewrites legacy model refs to `openai/*`, removes stale session and
whole-agent runtime pins, and preserves existing auth-profile overrides.

**The app-server is rejected:** use Codex app-server `0.125.0` or newer.
Same-version prereleases or build-suffixed versions such as
`0.125.0-alpha.2` or `0.125.0+custom` are rejected because OpenClaw tests the
stable `0.125.0` protocol floor.

**`/codex status` cannot connect:** check that the bundled `codex` plugin is
enabled, that `plugins.allow` includes it when an allowlist is configured, and
that any custom `appServer.command`, `url`, `authToken`, or headers are valid.

**Model discovery is slow:** lower
`plugins.entries.codex.config.discovery.timeoutMs` or disable discovery. See
[Codex harness reference](/plugins/codex-harness-reference#model-discovery).

**WebSocket transport fails immediately:** check `appServer.url`, `authToken`,
headers, and that the remote app-server speaks the same Codex app-server
protocol version.

**A non-Codex model uses PI:** that is expected unless provider or model runtime
policy routes it to another harness. Plain non-OpenAI provider refs stay on
their normal provider path in `auto` mode.

**Computer Use is installed but tools do not run:** check
`/codex computer-use status` from a fresh session. If a tool reports
`Native hook relay unavailable`, use `/new` or `/reset`; if it persists, restart
the gateway to clear stale native hook registrations. See
[Codex Computer Use](/plugins/codex-computer-use#troubleshooting).

## Related

- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Plugin hooks](/plugins/hooks)
- [Diagnostics export](/gateway/diagnostics)
- [Status](/cli/status)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
