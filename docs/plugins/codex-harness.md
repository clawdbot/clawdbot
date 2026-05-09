---
summary: "Run OpenClaw embedded agent turns through the bundled Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the bundled Codex app-server harness
  - You need Codex harness config examples
  - You want Codex-only deployments to fail instead of falling back to PI
---

The bundled `codex` plugin lets OpenClaw run embedded agent turns through the
Codex app-server instead of the built-in PI harness.

Use this when you want Codex to own the low-level agent session: model
discovery, native thread resume, native compaction, and app-server execution.
OpenClaw still owns chat channels, session files, model selection, tools,
approvals, media delivery, and the visible transcript mirror.

When a source chat turn runs through the Codex harness, visible replies default
to the OpenClaw `message` tool if the deployment has not explicitly configured
`messages.visibleReplies`. The agent can still finish its Codex turn privately;
it only posts to the channel when it calls `message(action="send")`. Set
`messages.visibleReplies: "automatic"` to keep direct-chat final replies on the
legacy automatic delivery path.

Codex heartbeat turns also get `heartbeat_respond` in the searchable OpenClaw
tool catalog by default, so the agent can record whether the wake should stay
quiet or notify without encoding that control flow in final text.

Heartbeat-specific initiative guidance is sent as a Codex collaboration-mode
developer instruction on the heartbeat turn itself. Ordinary chat turns restore
Codex Default mode instead of carrying heartbeat philosophy in their normal
runtime prompt.

If you are trying to orient yourself, start with
[Agent runtimes](/concepts/agent-runtimes). The short version is:
`openai/gpt-5.5` is the model ref, `codex` is the runtime, and Telegram,
Discord, Slack, or another channel remains the communication surface.

## Quick config

Most users who want "Codex in OpenClaw" want this route: sign in with a
ChatGPT/Codex subscription, then run embedded agent turns through the native
Codex app-server runtime. The model ref still stays canonical as
`openai/gpt-*`; subscription auth comes from the Codex account/profile, not
from an `openai-codex/*` model prefix.

First sign in with Codex OAuth if you have not already:

```bash
openclaw models auth login --provider openai-codex
```

Then enable the bundled `codex` plugin and use the canonical OpenAI model ref.
OpenAI agent turns select the Codex runtime by default:

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

If your config uses `plugins.allow`, include `codex` there too:

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

Do not use `openai-codex/gpt-*` in config. That prefix is a legacy route that
`openclaw doctor --fix` rewrites to `openai/gpt-*` across primary models,
fallbacks, heartbeat/subagent/compaction overrides, hooks, channel overrides,
and stale persisted session route pins.

## What this plugin changes

The bundled `codex` plugin contributes several separate capabilities:

| Capability                        | How you use it                                      | What it does                                                                  |
| --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Native embedded runtime           | `openai/gpt-*` agent model refs                     | Runs OpenClaw embedded agent turns through Codex app-server.                  |
| Native chat-control commands      | `/codex bind`, `/codex resume`, `/codex steer`, ... | Binds and controls Codex app-server threads from a messaging conversation.    |
| Codex app-server provider/catalog | `codex` internals, surfaced through the harness     | Lets the runtime discover and validate app-server models.                     |
| Codex media-understanding path    | `codex/*` image-model compatibility paths           | Runs bounded Codex app-server turns for supported image understanding models. |
| Native hook relay                 | Plugin hooks around Codex-native events             | Lets OpenClaw observe/block supported Codex-native tool/finalization events.  |

Enabling the plugin makes those capabilities available. It does **not**:

- replace direct OpenAI API-key surfaces such as images, embeddings, speech, or
  realtime
- convert `openai-codex/*` model refs without `openclaw doctor --fix`
- make ACP/acpx the default Codex path
- use stale whole-agent or session runtime pins for routing
- replace OpenClaw channel delivery, session files, auth-profile storage, or
  message routing

The same plugin also owns the native `/codex` chat-control command surface. If
the plugin is enabled and the user asks to bind, resume, steer, stop, or inspect
Codex threads from chat, agents should prefer `/codex ...` over ACP. ACP remains
the explicit fallback when the user asks for ACP/acpx or is testing the ACP
Codex adapter.

Native Codex turns keep OpenClaw plugin hooks as the public compatibility layer.
These are in-process OpenClaw hooks, not Codex `hooks.json` command hooks:

- `before_prompt_build`
- `before_compaction`, `after_compaction`
- `llm_input`, `llm_output`
- `before_tool_call`, `after_tool_call`
- `before_message_write` for mirrored transcript records
- `before_agent_finalize` through Codex `Stop` relay
- `agent_end`

Plugins can also register runtime-neutral tool-result middleware to rewrite
OpenClaw dynamic tool results after OpenClaw executes the tool and before the
result is returned to Codex. This is separate from the public
`tool_result_persist` plugin hook, which transforms OpenClaw-owned transcript
tool-result writes.

For the plugin hook semantics themselves, see [Plugin hooks](/plugins/hooks)
and [Plugin guard behavior](/tools/plugin).

OpenAI agent model refs use the harness by default. New configs should keep
OpenAI model refs canonical as `openai/gpt-*`; provider/model
`agentRuntime.id: "codex"` is still valid but no longer required for OpenAI
agent turns. Legacy `codex/*` model refs still auto-select the harness for
compatibility, but
runtime-backed legacy provider prefixes are not shown as normal model/provider
choices.

If any configured model route is still `openai-codex/*`, `openclaw doctor --fix`
rewrites it to `openai/*` and preserves existing `openai-codex` auth profile
overrides. It does not pin the whole agent to `agentRuntime.id: "codex"` because
canonical OpenAI refs already select the Codex harness automatically.

## Route map

Use this table before changing config:

| Desired behavior                                     | Model ref                  | Runtime config                                           | Auth/profile route             | Expected status label        |
| ---------------------------------------------------- | -------------------------- | -------------------------------------------------------- | ------------------------------ | ---------------------------- |
| ChatGPT/Codex subscription with native Codex runtime | `openai/gpt-*`             | omitted or provider/model `agentRuntime.id: "codex"`     | Codex OAuth or Codex account   | `Runtime: OpenAI Codex`      |
| OpenAI API-key auth for agent models                 | `openai/gpt-*`             | omitted or provider/model `agentRuntime.id: "codex"`     | `openai-codex` API-key profile | `Runtime: OpenAI Codex`      |
| Legacy config that needs doctor repair               | `openai-codex/gpt-*`       | preserved or automatic                                   | Existing configured auth       | Recheck after `doctor --fix` |
| Mixed providers with conservative auto mode          | provider-specific refs     | omitted unless a provider/model needs a runtime override | Per selected provider          | Depends on selected runtime  |
| Explicit Codex ACP adapter session                   | ACP prompt/model dependent | `sessions_spawn` with `runtime: "acp"`                   | ACP backend auth               | ACP task/session status      |

The important split is provider versus runtime:

- `openai-codex/*` is a legacy route that doctor rewrites.
- Provider/model `agentRuntime.id: "codex"` requires the Codex harness and fails
  closed if it is unavailable.
- Provider/model `agentRuntime.id: "auto"` lets registered harnesses claim
  matching provider routes; OpenAI agent refs resolve to Codex instead of PI.
- `/codex ...` answers "which native Codex conversation should this chat bind
  or control?"
- ACP answers "which external harness process should acpx launch?"

## Pick the right model prefix

OpenAI-family routes are prefix-specific. For the common subscription plus
native Codex runtime setup, use `openai/*`.
Treat `openai-codex/*` as legacy config that doctor should rewrite:

| Model ref                                         | Runtime path                             | Use when                                                          |
| ------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `openai/gpt-5.4`                                  | Codex app-server harness for agent turns | You want OpenAI agent models through Codex.                       |
| `openai-codex/gpt-5.5`                            | Legacy route repaired by doctor          | You are on old config; run `openclaw doctor --fix` to rewrite it. |
| `openai/gpt-5.5` + `openai-codex` API-key profile | Codex app-server harness                 | You want API-key auth for an OpenAI agent model.                  |

GPT-5.5 can appear on both direct OpenAI API-key and Codex subscription routes
when your account exposes them. Use `openai/gpt-5.5` with the Codex app-server
harness for native Codex runtime. For direct API-key traffic through PI, opt in
with provider/model `agentRuntime.id: "pi"` and a normal `openai` auth profile.

Legacy `codex/gpt-*` refs remain accepted as compatibility aliases. Doctor
compatibility migration rewrites legacy runtime refs to canonical model refs
and records the runtime policy separately. New native app-server harness configs
should use `openai/gpt-*`; explicit provider/model `agentRuntime.id: "codex"`
is only needed when you want the policy written down.

`agents.defaults.imageModel` follows the same prefix split. Use
`openai/gpt-*` for the normal OpenAI route and `codex/gpt-*` when image
understanding should run through a bounded Codex app-server turn. Do not use
`openai-codex/gpt-*`; doctor rewrites that legacy prefix to `openai/gpt-*`. The
Codex app-server model must advertise image input support; text-only Codex
models fail before the media turn starts.

Use `/status` to confirm the effective harness for the current session. If the
selection is surprising, enable debug logging for the `agents/harness` subsystem
and inspect the gateway's structured `agent harness selected` record. It
includes the selected harness id, selection reason, runtime/fallback policy, and,
in `auto` mode, each plugin candidate's support result.

### What doctor warnings mean

`openclaw doctor` warns when configured model refs or persisted session route
state still use `openai-codex/*`. `openclaw doctor --fix` rewrites those routes
to `openai/<model>`. Canonical OpenAI agent refs already select the native Codex
harness, so doctor does not pin the whole agent to Codex.

Whole-session and whole-agent runtime pins are legacy state. Runtime selection
now comes from provider/model policy; `openclaw doctor --fix` removes stale
session pins and old whole-agent runtime config so they do not mask the selected
provider/model route.

`/status` shows the effective model runtime. The default PI harness appears as
`Runtime: OpenClaw Pi Default`, and the Codex app-server harness appears as
`Runtime: OpenAI Codex`.

## Requirements

- OpenClaw with the bundled `codex` plugin available.
- Codex app-server `0.125.0` or newer. The bundled plugin manages a compatible
  Codex app-server binary by default, so local `codex` commands on `PATH` do
  not affect normal harness startup.
- Codex auth available to the app-server process or to OpenClaw's Codex auth
  bridge. Local app-server launches use an OpenClaw-managed Codex home for each
  agent and an isolated child `HOME`, so they do not read your personal
  `~/.codex` account, skills, plugins, config, thread state, or native
  `$HOME/.agents/skills` by default.

The plugin blocks older or unversioned app-server handshakes. That keeps
OpenClaw on the protocol surface it has been tested against.

For live and Docker smoke tests, auth usually comes from the Codex CLI account
or an OpenClaw `openai-codex` auth profile. Local stdio app-server launches can
also fall back to `CODEX_API_KEY` / `OPENAI_API_KEY` when no account is present.

## Workspace bootstrap files

Codex handles `AGENTS.md` itself through native project-doc discovery. OpenClaw
does not write synthetic Codex project-doc files or depend on Codex fallback
filenames for persona files, because Codex fallbacks only apply when
`AGENTS.md` is missing.

For OpenClaw workspace parity, the Codex harness resolves the other bootstrap
files (`SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`,
`BOOTSTRAP.md`, and `MEMORY.md` when present) and forwards them through Codex
developer instructions on `thread/start` and `thread/resume`. This keeps
`SOUL.md` and related workspace persona/profile context visible on the native
Codex behavior-shaping lane without duplicating `AGENTS.md`.

## Add Codex alongside other models

Do not set a whole-agent runtime. Whole-agent runtime pins are legacy and
ignored, and they were the source of mixed-provider traps after upgrades. Keep
runtime policy on the provider or model that needs it.

Use one of these shapes instead:

- Use `openai/gpt-*` for OpenAI agent turns; Codex is selected by default.
- Put runtime overrides on `models.providers.<provider>.agentRuntime` or on a
  model entry such as `agents.defaults.models["anthropic/claude-opus-4-7"].agentRuntime`.
- Use legacy `codex/*` refs only for compatibility. New configs should prefer
  `openai/*`; add an explicit Codex runtime policy only when you need to make
  the provider/model rule strict.

For example, this keeps mixed-provider routing ergonomic while using OpenAI
through Codex by default and Claude through PI:

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

With this shape:

- The default `main` agent uses the normal provider path and PI compatibility fallback.
- The `codex` agent uses the Codex app-server harness.
- If Codex is missing or unsupported for the `codex` agent, the turn fails
  instead of quietly using PI.

## Agent command routing

Agents should route user requests by intent, not by the word "Codex" alone:

| User asks for...                                       | Agent should use...                              |
| ------------------------------------------------------ | ------------------------------------------------ |
| "Bind this chat to Codex"                              | `/codex bind`                                    |
| "Resume Codex thread `<id>` here"                      | `/codex resume <id>`                             |
| "Show Codex threads"                                   | `/codex threads`                                 |
| "File a support report for a bad Codex run"            | `/diagnostics [note]`                            |
| "Only send Codex feedback for this attached thread"    | `/codex diagnostics [note]`                      |
| "Use my ChatGPT/Codex subscription with Codex runtime" | `openai/*`                                       |
| "Repair old `openai-codex/*` config/session pins"      | `openclaw doctor --fix`                          |
| "Run Codex through ACP/acpx"                           | ACP `sessions_spawn({ runtime: "acp", ... })`    |
| "Start Claude Code/Gemini/OpenCode/Cursor in a thread" | ACP/acpx, not `/codex` and not native sub-agents |

OpenClaw only advertises ACP spawn guidance to agents when ACP is enabled,
dispatchable, and backed by a loaded runtime backend. If ACP is not available,
the system prompt and plugin skills should not teach the agent about ACP
routing.

## Codex-only deployments

For OpenAI agent turns, `openai/gpt-*` already resolves to Codex. If you need a
strict written policy, put it on the OpenAI provider or model. Explicit plugin
runtimes fail closed and are never silently retried through PI:

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
  agents: { defaults: { model: "openai/gpt-5.5" } },
}
```

With Codex forced, OpenClaw fails early if the Codex plugin is disabled, the
app-server is too old, or the app-server cannot start.

## Per-agent Codex

You can make one agent Codex-strict while the default agent keeps normal
selection by using a per-agent model runtime override:

```json5
{
  agents: {
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
        models: {
          "openai/gpt-5.5": {
            agentRuntime: {
              id: "codex",
            },
          },
        },
      },
    ],
  },
}
```

Use normal session commands to switch agents and models. `/new` creates a fresh
OpenClaw session and the Codex harness creates or resumes its sidecar app-server
thread as needed. `/reset` clears the OpenClaw session binding for that thread
and lets the next turn resolve the harness from current config again.

## Model discovery

By default, the Codex plugin asks the app-server for available models. Model
availability is owned by the Codex app-server harness, so the list can change
when OpenClaw upgrades the bundled `@openai/codex` version or when a deployment
points `appServer.command` at a different Codex binary. Availability can also be
account-scoped. Use `/codex models` on a running gateway to see the live catalog
for that harness and account.

If discovery fails or times out, OpenClaw uses a bundled fallback catalog for:

- GPT-5.5
- GPT-5.4 mini
- GPT-5.2

The current bundled harness is `@openai/codex` `0.129.0`. A `model/list` probe
against that bundled app-server returned:

| Model id            | Default | Hidden | Input modalities | Reasoning efforts        |
| ------------------- | ------- | ------ | ---------------- | ------------------------ |
| `gpt-5.5`           | Yes     | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.4`           | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.4-mini`      | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.3-codex`     | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.2`           | No      | No     | text, image      | low, medium, high, xhigh |
| `codex-auto-review` | No      | Yes    | text, image      | low, medium, high, xhigh |

Hidden models are returned by the app-server catalog for internal or specialized
flows, but they are not normal model-picker choices.

You can tune discovery under `plugins.entries.codex.config.discovery`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 2500,
          },
        },
      },
    },
  },
}
```

Disable discovery when you want startup to avoid probing Codex and stick to the
fallback catalog:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: false,
          },
        },
      },
    },
  },
}
```

## App-server connection and policy

By default, the plugin starts OpenClaw's managed Codex binary locally with:

```bash
codex app-server --listen stdio://
```

The managed binary is shipped with the `codex` plugin package. This keeps the
app-server version tied to the bundled plugin instead of whichever separate
Codex CLI happens to be installed locally. Set `appServer.command` only when
you intentionally want to run a different executable.

By default, OpenClaw starts local Codex harness sessions in YOLO mode:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. This is the trusted local operator posture used
for autonomous heartbeats: Codex can use shell and network tools without
stopping on native approval prompts that nobody is around to answer. On local
stdio Codex app-server installs where Codex's system requirements file
disallows the implicit YOLO approval, reviewer, or sandbox value, OpenClaw
treats the implicit default as guardian instead and selects allowed guardian
permissions so it does not send an override that Codex app-server will reject.
Hostname-matching `[[remote_sandbox_config]]` entries in the same requirements
file are honored for the sandbox default decision.

To opt in to Codex guardian-reviewed approvals, set `appServer.mode:
"guardian"`:

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

Guardian mode uses Codex's native auto-review approval path. When Codex asks to
leave the sandbox, write outside the workspace, or add permissions like network
access, Codex routes that approval request to the native reviewer instead of a
human prompt. The reviewer applies Codex's risk framework and approves or denies
the specific request. Use Guardian when you want more guardrails than YOLO mode
but still need unattended agents to make progress.

The `guardian` preset expands to `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"`.
Individual policy fields still override `mode`, so advanced deployments can mix
the preset with explicit choices. The older `guardian_subagent` reviewer value is
still accepted as a compatibility alias, but new configs should use
`auto_review`.

For an already-running app-server, use WebSocket transport:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://127.0.0.1:39175",
            authToken: "${CODEX_APP_SERVER_TOKEN}",
            requestTimeoutMs: 60000,
          },
        },
      },
    },
  },
}
```

Stdio app-server launches inherit OpenClaw's process environment by default,
but OpenClaw owns the Codex app-server account bridge and sets both
`CODEX_HOME` and `HOME` to per-agent directories under that agent's OpenClaw
state. Codex's own skill loader reads `$CODEX_HOME/skills` and
`$HOME/.agents/skills`, so both values are isolated for local app-server
launches. That keeps Codex-native skills, plugins, config, accounts, and thread
state scoped to the OpenClaw agent instead of leaking in from the operator's
personal Codex CLI home.

OpenClaw plugins and OpenClaw skill snapshots still flow through OpenClaw's own
plugin registry and skill loader. Personal Codex CLI assets do not. If you have
useful Codex CLI skills or plugins that should become part of an OpenClaw agent,
inventory them explicitly:

```bash
openclaw migrate codex --dry-run
openclaw migrate apply codex --yes
```

The Codex migration provider copies skills into the current OpenClaw agent
workspace. For source-installed `openai-curated` Codex plugins, migration also
calls Codex app-server `plugin/install` and records explicit native plugin
config under `plugins.entries.codex.config.codexPlugins`. Codex config files,
hooks, and cached plugin bundles that are not source-installed curated plugins
remain report-only manual-review items.

Auth is selected in this order:

1. An explicit OpenClaw Codex auth profile for the agent.
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

Codex dynamic tools default to the `native-first` profile and `searchable`
loading. In that mode, OpenClaw does not expose dynamic tools that duplicate
Codex-native workspace operations: `read`, `write`, `edit`, `apply_patch`,
`exec`, `process`, and `update_plan`. Remaining OpenClaw integration tools such
as messaging, sessions, media, cron, browser, nodes, gateway,
`heartbeat_respond`, and `web_search` are available through Codex tool search
under the `openclaw` namespace, keeping the initial model context smaller.
`sessions_yield` and message-tool-only source replies stay direct because those
are turn-control contracts. Heartbeat collaboration instructions tell Codex to
search for `heartbeat_respond` before ending a heartbeat turn when the tool is
not already loaded.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom Codex
app-server that cannot search deferred dynamic tools or when debugging the full
tool payload.

Supported top-level Codex plugin fields:

| Field                      | Default          | Meaning                                                                                   |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `codexDynamicToolsProfile` | `"native-first"` | Use `"openclaw-compat"` to expose the full OpenClaw dynamic tool set to Codex app-server. |
| `codexDynamicToolsLoading` | `"searchable"`   | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context.  |
| `codexDynamicToolsExclude` | `[]`             | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.               |
| `codexPlugins`             | disabled         | Native Codex plugin/app support for migrated source-installed curated plugins.            |

Supported `appServer` fields:

| Field                         | Default                                                | Meaning                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transport`                   | `"stdio"`                                              | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                                                                                                                                             |
| `command`                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                                                                                                                         |
| `args`                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                       |
| `url`                         | unset                                                  | WebSocket app-server URL.                                                                                                                                                                                                            |
| `authToken`                   | unset                                                  | Bearer token for WebSocket transport.                                                                                                                                                                                                |
| `headers`                     | `{}`                                                   | Extra WebSocket headers.                                                                                                                                                                                                             |
| `clearEnv`                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. `CODEX_HOME` and `HOME` are reserved for OpenClaw's per-agent Codex isolation on local launches. |
| `requestTimeoutMs`            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                          |
| `turnCompletionIdleTimeoutMs` | `60000`                                                | Quiet window after a turn-scoped Codex app-server request while OpenClaw waits for `turn/completed`. Raise this for slow post-tool or status-only synthesis phases.                                                                  |
| `mode`                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution. Local stdio requirements that omit `danger-full-access`, `never` approval, or the `user` reviewer make the implicit default guardian.                                                |
| `approvalPolicy`              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start/resume/turn. Guardian defaults prefer `"on-request"` when allowed.                                                                                                                 |
| `sandbox`                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start/resume. Guardian defaults prefer `"workspace-write"` when allowed, otherwise `"read-only"`.                                                                                           |
| `approvalsReviewer`           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed, otherwise `guardian_subagent` or `user`. `guardian_subagent` remains a legacy alias.                                                                   |
| `serviceTier`                 | unset                                                  | Optional Codex app-server service tier. `"priority"` enables fast-mode routing, `"flex"` requests flex processing, `null` clears the override, and legacy `"fast"` is accepted as `"priority"`.                                      |

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`: each Codex `item/tool/call` request must receive
an OpenClaw response within 30 seconds. On timeout, OpenClaw aborts the tool
signal where supported and returns a failed dynamic-tool response to Codex so
the turn can continue instead of leaving the session in `processing`.

After OpenClaw responds to a Codex turn-scoped app-server request, the harness
also expects Codex to finish the native turn with `turn/completed`. If the
app-server goes quiet for `appServer.turnCompletionIdleTimeoutMs` after that
response, OpenClaw best-effort interrupts the Codex turn, records a diagnostic
timeout, and releases the OpenClaw session lane so follow-up chat messages are
not queued behind a stale native turn. Any non-terminal notification for the
same turn, including `rawResponseItem/completed`, disarms that short watchdog
because Codex has proven the turn is still alive; the longer terminal watchdog
continues to protect genuinely stuck turns. Timeout diagnostics include the
last app-server notification method and, for raw assistant response items, the
item type, role, id, and a bounded assistant text preview.

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
dynamic tools. That keeps plugin calls in the native Codex transcript and avoids
starting a second ephemeral Codex thread for each plugin invocation.

Codex plugins only work when the selected OpenClaw agent runtime is the native
Codex harness. The `codexPlugins` config has no effect on Pi runs, normal
OpenAI provider runs, ACP conversation bindings, or other harnesses, because
those paths do not create Codex app-server threads with native `apps` config.

V1 support is intentionally narrow:

- Only `openai-curated` plugins that were already installed in the source Codex
  app-server inventory are migration-eligible.
- Migration writes explicit plugin identities with `marketplaceName` and
  `pluginName`; it does not write local `marketplacePath` cache paths.
- `codexPlugins.enabled` is the global enablement switch. There is no
  `plugins["*"]` wildcard and no config key that grants arbitrary install
  authority.
- Unsupported marketplaces, cached plugin bundles, hooks, and Codex config files
  are preserved in the migration report for manual review.

Example migrated config:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: false,
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

OpenClaw reads Codex app inventory through app-server `app/list`, caches it for
one hour, and refreshes stale or missing entries asynchronously. A plugin app is
exposed only when OpenClaw can map it back to the migrated plugin through stable
ownership: an exact app id from plugin detail, a known MCP server name, or
unique stable metadata. Display-name-only or ambiguous ownership is excluded
until the next inventory refresh proves ownership.

Plugin-owned app tools use Codex's native app configuration. OpenClaw injects a
restrictive `config.apps` patch for the Codex thread: `_default` is disabled and
only apps owned by enabled migrated plugins are enabled. OpenClaw sets
app-level `destructive_enabled` from the effective global/per-plugin
`allow_destructive_actions` policy and lets Codex enforce destructive tool
metadata from its native app tool annotations. Plugin apps are emitted with
`open_world_enabled: true`; OpenClaw does not expose a separate plugin
open-world policy knob. OpenClaw does not maintain per-plugin destructive
tool-name deny lists. Tool approval mode is prompted by default for plugin
apps, because OpenClaw does not have an interactive app-elicitation UI in this
same-thread path.

Destructive plugin elicitations fail closed by default:

- Global `allow_destructive_actions` defaults to `false`.
- Per-plugin `allow_destructive_actions` overrides the global policy for that
  plugin.
- When policy is `false`, OpenClaw returns a deterministic decline.
- When policy is `true`, OpenClaw auto-accepts only safe schemas it can map to
  an approval response, such as a boolean approve field.
- Missing plugin identity, ambiguous ownership, a missing turn id, a wrong turn
  id, or an unsafe elicitation schema declines instead of prompting.

Common diagnostics:

- `auth_required`: migration installed the plugin but one of its apps still
  needs authentication. The explicit plugin entry is written disabled until you
  reauthorize and enable it.
- `marketplace_missing` or `plugin_missing`: the target Codex app-server cannot
  see the expected `openai-curated` marketplace or plugin.
- `app_inventory_missing` or `app_inventory_stale`: app readiness came from an
  empty or stale cache; OpenClaw schedules an async refresh and excludes plugin
  apps until ownership/readiness is known.
- `app_ownership_ambiguous`: app inventory only matched by display name, so the
  app is not exposed to the Codex thread.

## Computer use

Computer Use is covered in its own setup guide:
[Codex Computer Use](/plugins/codex-computer-use).

The short version: OpenClaw does not vendor the desktop-control app or execute
desktop actions itself. It prepares Codex app-server, verifies that the
`computer-use` MCP server is available, and then lets Codex handle the native
MCP tool calls during Codex-mode turns.

For direct TryCua driver access outside the Codex marketplace flow, register
`cua-driver mcp` with `openclaw mcp set cua-driver '{"command":"cua-driver","args":["mcp"]}'`.
See [Codex Computer Use](/plugins/codex-computer-use) for the distinction
between Codex-owned Computer Use and direct MCP registration.

Minimal config:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          computerUse: {
            autoInstall: true,
          },
        },
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

The setup can be checked or installed from the command surface:

- `/codex computer-use status`
- `/codex computer-use install`
- `/codex computer-use install --source <marketplace-source>`
- `/codex computer-use install --marketplace-path <path>`

Computer Use is macOS-specific and may require local OS permissions before the
Codex MCP server can control apps. If `computerUse.enabled` is true and the MCP
server is unavailable, Codex-mode turns fail before the thread starts instead of
silently running without the native Computer Use tools. See
[Codex Computer Use](/plugins/codex-computer-use) for marketplace choices,
remote catalog limits, status reasons, and troubleshooting.

When `computerUse.autoInstall` is true, OpenClaw can register the standard
bundled Codex Desktop marketplace from
`/Applications/Codex.app/Contents/Resources/plugins/openai-bundled` if Codex
has not discovered a local marketplace yet. Use `/new` or `/reset` after
changing runtime or Computer Use config so existing sessions do not keep an old
PI or Codex thread binding.

## Common recipes

Local Codex with default stdio transport:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

Codex-only harness validation:

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

Guardian-reviewed Codex approvals:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            mode: "guardian",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: "workspace-write",
          },
        },
      },
    },
  },
}
```

Remote app-server with explicit headers:

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
            headers: {
              "X-OpenClaw-Agent": "main",
            },
          },
        },
      },
    },
  },
}
```

Model switching stays OpenClaw-controlled. When an OpenClaw session is attached
to an existing Codex thread, the next turn sends the currently selected
OpenAI model, provider, approval policy, sandbox, and service tier to
app-server again. Switching from `openai/gpt-5.5` to `openai/gpt-5.2` keeps the
thread binding but asks Codex to continue with the newly selected model.

## Codex command

The bundled plugin registers `/codex` as an authorized slash command. It is
generic and works on any channel that supports OpenClaw text commands.

Common forms:

- `/codex status` shows live app-server connectivity, models, account, rate limits, MCP servers, and skills.
- `/codex models` lists live Codex app-server models.
- `/codex threads [filter]` lists recent Codex threads.
- `/codex resume <thread-id>` attaches the current OpenClaw session to an existing Codex thread.
- `/codex compact` asks Codex app-server to compact the attached thread.
- `/codex review` starts Codex native review for the attached thread.
- `/codex diagnostics [note]` asks before sending Codex diagnostics feedback for the attached thread.
- `/codex computer-use status` checks the configured Computer Use plugin and MCP server.
- `/codex computer-use install` installs the configured Computer Use plugin and reloads MCP servers.
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.

When Codex reports a usage-limit failure, OpenClaw includes the next
app-server reset time when Codex provided one. Use `/codex account` in the same
conversation to inspect the current account and rate-limit windows.

### Common debugging workflow

When a Codex-backed agent does something surprising in Telegram, Discord, Slack,
or another channel, start with the conversation where the problem happened:

1. Run `/diagnostics bad tool choice after image upload` or another short note
   that describes what you saw.
2. Approve the diagnostics request once. The approval creates the local Gateway
   diagnostics zip and, because the session is using the Codex harness, also
   sends the relevant Codex feedback bundle to OpenAI servers.
3. Copy the completed diagnostics reply into the bug report or support thread.
   It includes the local bundle path, privacy summary, OpenClaw session ids,
   Codex thread ids, and an `Inspect locally` line for each Codex thread.
4. If you want to debug the run yourself, run the printed `Inspect locally`
   command in a terminal. It looks like `codex resume <thread-id>` and opens the
   native Codex thread so you can inspect the conversation, continue it locally,
   or ask Codex why it chose a particular tool or plan.

Use `/codex diagnostics [note]` only when you specifically want the Codex
feedback upload for the currently attached thread without the full OpenClaw
Gateway diagnostics bundle. For most support reports, `/diagnostics [note]` is
the better starting point because it ties the local Gateway state and Codex
thread ids together in one reply. See [Diagnostics export](/gateway/diagnostics)
for the full privacy model and group-chat behavior.

Core OpenClaw also exposes owner-only `/diagnostics [note]` as the general
Gateway diagnostics command. Its approval prompt shows the sensitive-data
preamble, links to [Diagnostics Export](/gateway/diagnostics), and requests
`openclaw gateway diagnostics export --json` through explicit exec approval
every time. Do not approve diagnostics with an allow-all rule. After approval,
OpenClaw sends a pasteable report with the local bundle path and manifest
summary. When the active OpenClaw session is using the Codex harness, that
same approval also authorizes sending the relevant Codex feedback bundles to
OpenAI servers. The approval prompt says that Codex feedback will be sent, but
it does not list Codex session or thread ids before approval.

If `/diagnostics` is invoked by an owner in a group chat, OpenClaw keeps the
shared channel clean: the group receives only a short notice, while the
diagnostics preamble, approval prompts, and Codex session/thread ids are sent to
the owner through the private approval route. If there is no private owner route,
OpenClaw refuses the group request and asks the owner to run it from a DM.

The approved Codex upload calls Codex app-server `feedback/upload` and asks
app-server to include logs for each listed thread and spawned Codex subthreads
when available. The upload goes through Codex's normal feedback path to OpenAI
servers; if Codex feedback is disabled in that app-server, the command returns
the app-server error. The completed diagnostics reply lists the channels,
OpenClaw session ids, Codex thread ids, and local `codex resume <thread-id>`
commands for the threads that were sent. If you deny or ignore the approval,
OpenClaw does not print those Codex ids. This upload does not replace the local
Gateway diagnostics export.

`/codex resume` writes the same sidecar binding file that the harness uses for
normal turns. On the next message, OpenClaw resumes that Codex thread, passes the
currently selected OpenClaw model into app-server, and keeps extended history
enabled.

### Inspect a Codex thread from the CLI

The fastest way to understand a bad Codex run is often to open the native Codex
thread directly:

```sh
codex resume <thread-id>
```

Use this when you notice a bug in a channel conversation and want to inspect the
problematic Codex session, continue it locally, or ask Codex why it made a
particular tool or reasoning choice. The easiest path is usually to run
`/diagnostics [note]` first: after you approve it, the completed report lists
each Codex thread and prints an `Inspect locally` command, for example
`codex resume <thread-id>`. You can copy that command directly into a terminal.

You can also get a thread id from `/codex binding` for the current chat or
`/codex threads [filter]` for recent Codex app-server threads, then run the same
`codex resume` command in your shell.

The command surface requires Codex app-server `0.125.0` or newer. Individual
control methods are reported as `unsupported by this Codex app-server` if a
future or custom app-server does not expose that JSON-RPC method.

## Hook boundaries

The Codex harness has three hook layers:

| Layer                                 | Owner                    | Purpose                                                             |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| OpenClaw plugin hooks                 | OpenClaw                 | Product/plugin compatibility across PI and Codex harnesses.         |
| Codex app-server extension middleware | OpenClaw bundled plugins | Per-turn adapter behavior around OpenClaw dynamic tools.            |
| Codex native hooks                    | Codex                    | Low-level Codex lifecycle and native tool policy from Codex config. |

OpenClaw does not use project or global Codex `hooks.json` files to route
OpenClaw plugin behavior. For the supported native tool and permission bridge,
OpenClaw injects per-thread Codex config for `PreToolUse`, `PostToolUse`,
`PermissionRequest`, and `Stop`. When Codex app-server approvals are enabled
(`approvalPolicy` is not `"never"`), the default injected native hook config
omits `PermissionRequest` so Codex's app-server reviewer and OpenClaw's approval
bridge handle real escalations after review. Operators can still explicitly add
`permission_request` to `nativeHookRelay.events` when they need the compatibility
relay. Other Codex hooks such as `SessionStart` and `UserPromptSubmit` remain
Codex-level controls; they are not exposed as OpenClaw plugin hooks in the v1
contract.

For OpenClaw dynamic tools, OpenClaw executes the tool after Codex asks for the
call, so OpenClaw fires the plugin and middleware behavior it owns in the
harness adapter. For Codex-native tools, Codex owns the canonical tool record.
OpenClaw can mirror selected events, but it cannot rewrite the native Codex
thread unless Codex exposes that operation through app-server or native hook
callbacks.

Compaction and LLM lifecycle projections come from Codex app-server
notifications and OpenClaw adapter state, not native Codex hook commands.
OpenClaw's `before_compaction`, `after_compaction`, `llm_input`, and
`llm_output` events are adapter-level observations, not byte-for-byte captures
of Codex's internal request or compaction payloads.

Codex native `hook/started` and `hook/completed` app-server notifications are
projected as `codex_app_server.hook` agent events for trajectory and debugging.
They do not invoke OpenClaw plugin hooks.

## V1 support contract

Codex mode is not PI with a different model call underneath. Codex owns more of
the native model loop, and OpenClaw adapts its plugin and session surfaces
around that boundary.

Supported in Codex runtime v1:

| Surface                                       | Support                                                                              | Why                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI model loop through Codex               | Supported                                                                            | Codex app-server owns the OpenAI turn, native thread resume, and native tool continuation.                                                                                                                 |
| OpenClaw channel routing and delivery         | Supported                                                                            | Telegram, Discord, Slack, WhatsApp, iMessage, and other channels stay outside the model runtime.                                                                                                           |
| OpenClaw dynamic tools                        | Supported                                                                            | Codex asks OpenClaw to execute these tools, so OpenClaw stays in the execution path.                                                                                                                       |
| Prompt and context plugins                    | Supported                                                                            | OpenClaw builds prompt overlays and projects context into the Codex turn before starting or resuming the thread.                                                                                           |
| Context engine lifecycle                      | Supported                                                                            | Assemble, ingest or after-turn maintenance, and context-engine compaction coordination run for Codex turns.                                                                                                |
| Dynamic tool hooks                            | Supported                                                                            | `before_tool_call`, `after_tool_call`, and tool-result middleware run around OpenClaw-owned dynamic tools.                                                                                                 |
| Lifecycle hooks                               | Supported as adapter observations                                                    | `llm_input`, `llm_output`, `agent_end`, `before_compaction`, and `after_compaction` fire with honest Codex-mode payloads.                                                                                  |
| Final-answer revision gate                    | Supported through the native hook relay                                              | Codex `Stop` is relayed to `before_agent_finalize`; `revise` asks Codex for one more model pass before finalization.                                                                                       |
| Native shell, patch, and MCP block or observe | Supported through the native hook relay                                              | Codex `PreToolUse` and `PostToolUse` are relayed for committed native tool surfaces, including MCP payloads on Codex app-server `0.125.0` or newer. Blocking is supported; argument rewriting is not.      |
| Native permission policy                      | Supported through Codex app-server approvals and the compatibility native hook relay | Codex app-server approval requests route through OpenClaw after Codex review. The `PermissionRequest` native hook relay is opt-in for native approval modes because Codex emits it before guardian review. |
| App-server trajectory capture                 | Supported                                                                            | OpenClaw records the request it sent to app-server and the app-server notifications it receives.                                                                                                           |

Not supported in Codex runtime v1:

| Surface                                             | V1 boundary                                                                                                                                     | Future path                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Native tool argument mutation                       | Codex native pre-tool hooks can block, but OpenClaw does not rewrite Codex-native tool arguments.                                               | Requires Codex hook/schema support for replacement tool input.                            |
| Editable Codex-native transcript history            | Codex owns canonical native thread history. OpenClaw owns a mirror and can project future context, but should not mutate unsupported internals. | Add explicit Codex app-server APIs if native thread surgery is needed.                    |
| `tool_result_persist` for Codex-native tool records | That hook transforms OpenClaw-owned transcript writes, not Codex-native tool records.                                                           | Could mirror transformed records, but canonical rewrite needs Codex support.              |
| Rich native compaction metadata                     | OpenClaw observes compaction start and completion, but does not receive a stable kept/dropped list, token delta, or summary payload.            | Needs richer Codex compaction events.                                                     |
| Compaction intervention                             | Current OpenClaw compaction hooks are notification-level in Codex mode.                                                                         | Add Codex pre/post compaction hooks if plugins need to veto or rewrite native compaction. |
| Byte-for-byte model API request capture             | OpenClaw can capture app-server requests and notifications, but Codex core builds the final OpenAI API request internally.                      | Needs a Codex model-request tracing event or debug API.                                   |

## Tools, media, and compaction

The Codex harness changes the low-level embedded agent executor only.

OpenClaw still builds the tool list and receives dynamic tool results from the
harness. Text, images, video, music, TTS, approvals, and messaging-tool output
continue through the normal OpenClaw delivery path.

The native hook relay is intentionally generic, but the v1 support contract is
limited to the Codex-native tool and permission paths that OpenClaw tests. In
the Codex runtime, that includes shell, patch, and MCP `PreToolUse`,
`PostToolUse`, and `PermissionRequest` payloads. Do not assume every future
Codex hook event is an OpenClaw plugin surface until the runtime contract names
it.

For `PermissionRequest`, OpenClaw only returns explicit allow or deny decisions
when policy decides. A no-decision result is not an allow. Codex treats it as no
hook decision and falls through to its own guardian or user approval path.
Codex app-server approval modes omit this native hook by default; this paragraph
applies when `permission_request` is explicitly included in
`nativeHookRelay.events` or a compatibility runtime installs it.
When an operator chooses `allow-always` for a Codex native permission request,
OpenClaw remembers that exact provider/session/tool input/cwd fingerprint for a
bounded session window. The remembered decision is intentionally exact-match
only: a changed command, arguments, tool payload, or cwd creates a fresh
approval.

Codex MCP tool approval elicitations are routed through OpenClaw's plugin
approval flow when Codex marks `_meta.codex_approval_kind` as
`"mcp_tool_call"`. Codex `request_user_input` prompts are sent back to the
originating chat, and the next queued follow-up message answers that native
server request instead of being steered as extra context. Other MCP elicitation
requests still fail closed.

Active-run queue steering maps onto Codex app-server `turn/steer`. With the
default `messages.queue.mode: "steer"`, OpenClaw batches queued chat messages
for the configured quiet window and sends them as one `turn/steer` request in
arrival order. Legacy `queue` mode sends separate `turn/steer` requests. Codex
review and manual compaction turns can reject same-turn steering, in which case
OpenClaw uses the followup queue when the selected mode allows fallback. See
[Steering queue](/concepts/queue-steering).

When the selected model uses the Codex harness, native thread compaction is
delegated to Codex app-server. OpenClaw keeps a transcript mirror for channel
history, search, `/new`, `/reset`, and future model or harness switching. The
mirror includes the user prompt, final assistant text, and lightweight Codex
reasoning or plan records when the app-server emits them. Today, OpenClaw only
records native compaction start and completion signals. It does not yet expose a
human-readable compaction summary or an auditable list of which entries Codex
kept after compaction.

Because Codex owns the canonical native thread, `tool_result_persist` does not
currently rewrite Codex-native tool result records. It only applies when
OpenClaw is writing an OpenClaw-owned session transcript tool result.

Media generation does not require PI. Image, video, music, PDF, TTS, and media
understanding continue to use the matching provider/model settings such as
`agents.defaults.imageGenerationModel`, `videoGenerationModel`, `pdfModel`, and
`messages.tts`.

## Troubleshooting

**Codex does not appear as a normal `/model` provider:** that is expected for
new configs. Select an `openai/gpt-*` model, enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`. Legacy `codex/*` refs remain compatibility aliases, not normal model
provider choices.

**OpenClaw uses PI instead of Codex:** make sure the model ref is `openai/gpt-*`
on the official OpenAI provider and that the Codex plugin is installed/enabled.
If you need a strict policy while testing, set provider/model
`agentRuntime.id: "codex"`. A forced Codex runtime fails instead of falling back
to PI. Once Codex app-server is selected, its failures surface directly.

**The app-server is rejected:** upgrade Codex so the app-server handshake
reports version `0.125.0` or newer. Same-version prereleases or build-suffixed
versions such as `0.125.0-alpha.2` or `0.125.0+custom` are rejected because the
stable `0.125.0` protocol floor is what OpenClaw tests.

**Model discovery is slow:** lower `plugins.entries.codex.config.discovery.timeoutMs`
or disable discovery.

**WebSocket transport fails immediately:** check `appServer.url`, `authToken`,
and that the remote app-server speaks the same Codex app-server protocol version.

**A non-Codex model uses PI:** that is expected unless provider/model runtime
policy routes it to another harness. Plain non-OpenAI provider refs stay on
their normal provider path in `auto` mode. If you force
`agentRuntime.id: "codex"` on a provider or model, matching embedded turns must
be Codex-supported OpenAI models.

**Computer Use is installed but tools do not run:** check
`/codex computer-use status` from a fresh session. If a tool reports
`Native hook relay unavailable`, use `/new` or `/reset`; if it persists, restart
the gateway to clear stale native hook registrations. If `computer-use.list_apps`
times out, restart Codex Computer Use or Codex Desktop and retry.

## Related

- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [Status](/cli/status)
- [Plugin hooks](/plugins/hooks)
- [Configuration reference](/gateway/configuration-reference)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
