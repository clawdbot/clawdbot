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

If you are trying to orient yourself, start with
[Agent runtimes](/concepts/agent-runtimes). The short version is:
`openai/gpt-5.5` is the model ref, `codex` is the runtime, and Telegram,
Discord, Slack, or another channel remains the communication surface.

## What this plugin changes

The bundled `codex` plugin contributes several separate capabilities:

| Capability                        | How you use it                                      | What it does                                                                  |
| --------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Native embedded runtime           | `agentRuntime.id: "codex"`                          | Runs OpenClaw embedded agent turns through Codex app-server.                  |
| Native chat-control commands      | `/codex bind`, `/codex resume`, `/codex steer`, ... | Binds and controls Codex app-server threads from a messaging conversation.    |
| Codex app-server provider/catalog | `codex` internals, surfaced through the harness     | Lets the runtime discover and validate app-server models.                     |
| Codex media-understanding path    | `codex/*` image-model compatibility paths           | Runs bounded Codex app-server turns for supported image understanding models. |
| Native hook relay                 | Plugin hooks around Codex-native events             | Lets OpenClaw observe/block supported Codex-native tool/finalization events.  |

Enabling the plugin makes those capabilities available. It does **not**:

- start using Codex for every OpenAI model
- convert `openai-codex/*` model refs into the native runtime
- make ACP/acpx the default Codex path
- hot-switch existing sessions that already recorded a PI runtime
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

The harness is off by default. New configs should keep OpenAI model refs
canonical as `openai/gpt-*` and explicitly force
`agentRuntime.id: "codex"` or `OPENCLAW_AGENT_RUNTIME=codex` when they
want native app-server execution. Legacy `codex/*` model refs still auto-select
the harness for compatibility, but runtime-backed legacy provider prefixes are
not shown as normal model/provider choices.

If the `codex` plugin is enabled but the primary model is still
`openai-codex/*`, `openclaw doctor` warns instead of changing the route. That is
intentional: `openai-codex/*` remains the PI Codex OAuth/subscription path, and
native app-server execution stays an explicit runtime choice.

## Route map

Use this table before changing config:

| Desired behavior                            | Model ref                  | Runtime config                         | Plugin requirement          | Expected status label          |
| ------------------------------------------- | -------------------------- | -------------------------------------- | --------------------------- | ------------------------------ |
| OpenAI API through normal OpenClaw runner   | `openai/gpt-*`             | omitted or `runtime: "pi"`             | OpenAI provider             | `Runtime: OpenClaw Pi Default` |
| Codex OAuth/subscription through PI         | `openai-codex/gpt-*`       | omitted or `runtime: "pi"`             | OpenAI Codex OAuth provider | `Runtime: OpenClaw Pi Default` |
| Native Codex app-server embedded turns      | `openai/gpt-*`             | `agentRuntime.id: "codex"`             | `codex` plugin              | `Runtime: OpenAI Codex`        |
| Mixed providers with conservative auto mode | provider-specific refs     | `agentRuntime.id: "auto"`              | Optional plugin runtimes    | Depends on selected runtime    |
| Explicit Codex ACP adapter session          | ACP prompt/model dependent | `sessions_spawn` with `runtime: "acp"` | healthy `acpx` backend      | ACP task/session status        |

The important split is provider versus runtime:

- `openai-codex/*` answers "which provider/auth route should PI use?"
- `agentRuntime.id: "codex"` answers "which loop should execute this
  embedded turn?"
- `/codex ...` answers "which native Codex conversation should this chat bind
  or control?"
- ACP answers "which external harness process should acpx launch?"

## Pick the right model prefix

OpenAI-family routes are prefix-specific. Use `openai-codex/*` when you want
Codex OAuth through PI; use `openai/*` when you want direct OpenAI API access or
when you are forcing the native Codex app-server harness:

| Model ref                                     | Runtime path                                 | Use when                                                                  |
| --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `openai/gpt-5.4`                              | OpenAI provider through OpenClaw/PI plumbing | You want current direct OpenAI Platform API access with `OPENAI_API_KEY`. |
| `openai-codex/gpt-5.5`                        | OpenAI Codex OAuth through OpenClaw/PI       | You want ChatGPT/Codex subscription auth with the default PI runner.      |
| `openai/gpt-5.5` + `agentRuntime.id: "codex"` | Codex app-server harness                     | You want native Codex app-server execution for the embedded agent turn.   |

GPT-5.5 is currently subscription/OAuth-only in OpenClaw. Use
`openai-codex/gpt-5.5` for PI OAuth, or `openai/gpt-5.5` with the Codex
app-server harness. Direct API-key access for `openai/gpt-5.5` is supported
once OpenAI enables GPT-5.5 on the public API.

Legacy `codex/gpt-*` refs remain accepted as compatibility aliases. Doctor
compatibility migration rewrites legacy primary runtime refs to canonical model
refs and records the runtime policy separately, while fallback-only legacy refs
are left unchanged because runtime is configured for the whole agent container.
New PI Codex OAuth configs should use `openai-codex/gpt-*`; new native
app-server harness configs should use `openai/gpt-*` plus
`agentRuntime.id: "codex"`.

`agents.defaults.imageModel` follows the same prefix split. Use
`openai-codex/gpt-*` when image understanding should run through the OpenAI
Codex OAuth provider path. Use `codex/gpt-*` when image understanding should run
through a bounded Codex app-server turn. The Codex app-server model must
advertise image input support; text-only Codex models fail before the media turn
starts.

Use `/status` to confirm the effective harness for the current session. If the
selection is surprising, enable debug logging for the `agents/harness` subsystem
and inspect the gateway's structured `agent harness selected` record. It
includes the selected harness id, selection reason, runtime/fallback policy, and,
in `auto` mode, each plugin candidate's support result.

### What doctor warnings mean

`openclaw doctor` warns when all of these are true:

- the bundled `codex` plugin is enabled or allowed
- an agent's primary model is `openai-codex/*`
- that agent's effective runtime is not `codex`

That warning exists because users often expect "Codex plugin enabled" to imply
"native Codex app-server runtime." OpenClaw does not make that leap. The warning
means:

- **No change is required** if you intended ChatGPT/Codex OAuth through PI.
- Change the model to `openai/<model>` and set
  `agentRuntime.id: "codex"` if you intended native app-server
  execution.
- Existing sessions still need `/new` or `/reset` after a runtime change,
  because session runtime pins are sticky.

Harness selection is not a live session control. When an embedded turn runs,
OpenClaw records the selected harness id on that session and keeps using it for
later turns in the same session id. Change `agentRuntime` config or
`OPENCLAW_AGENT_RUNTIME` when you want future sessions to use another harness;
use `/new` or `/reset` to start a fresh session before switching an existing
conversation between PI and Codex. This avoids replaying one transcript through
two incompatible native session systems.

Legacy sessions created before harness pins are treated as PI-pinned once they
have transcript history. Use `/new` or `/reset` to opt that conversation into
Codex after changing config.

`/status` shows the effective model runtime. The default PI harness appears as
`Runtime: OpenClaw Pi Default`, and the Codex app-server harness appears as
`Runtime: OpenAI Codex`.

## Requirements

- OpenClaw with the bundled `codex` plugin available.
- Codex app-server `0.125.0` or newer. The bundled plugin manages a compatible
  Codex app-server binary by default, so local `codex` commands on `PATH` do
  not affect normal harness startup.
- Codex auth available to the app-server process or to OpenClaw's Codex auth
  bridge.

The plugin blocks older or unversioned app-server handshakes. That keeps
OpenClaw on the protocol surface it has been tested against.

For live and Docker smoke tests, auth usually comes from the Codex CLI account
or an OpenClaw `openai-codex` auth profile. Local stdio app-server launches can
also fall back to `CODEX_API_KEY` / `OPENAI_API_KEY` when no account is present.

## Minimal config

Use `openai/gpt-5.5`, enable the bundled plugin, and force the `codex` harness:

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
      agentRuntime: {
        id: "codex",
      },
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

Legacy configs that set `agents.defaults.model` or an agent model to
`codex/<model>` still auto-enable the bundled `codex` plugin. New configs should
prefer `openai/<model>` plus the explicit `agentRuntime` entry above.

## Add Codex alongside other models

Do not set `agentRuntime.id: "codex"` globally if the same agent should freely switch
between Codex and non-Codex provider models. A forced runtime applies to every
embedded turn for that agent or session. If you select an Anthropic model while
that runtime is forced, OpenClaw still tries the Codex harness and fails closed
instead of silently routing that turn through PI.

Use one of these shapes instead:

- Put Codex on a dedicated agent with `agentRuntime.id: "codex"`.
- Keep the default agent on `agentRuntime.id: "auto"` and PI fallback for normal mixed
  provider usage.
- Use legacy `codex/*` refs only for compatibility. New configs should prefer
  `openai/*` plus an explicit Codex runtime policy.

For example, this keeps the default agent on normal automatic selection and
adds a separate Codex agent:

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
      agentRuntime: {
        id: "auto",
        fallback: "pi",
      },
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
        agentRuntime: {
          id: "codex",
        },
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

| User asks for...                                         | Agent should use...                              |
| -------------------------------------------------------- | ------------------------------------------------ |
| "Bind this chat to Codex"                                | `/codex bind`                                    |
| "Resume Codex thread `<id>` here"                        | `/codex resume <id>`                             |
| "Show Codex threads"                                     | `/codex threads`                                 |
| "File a support report for a bad Codex run"              | `/diagnostics [note]`                            |
| "Only send Codex feedback for this attached thread"      | `/codex diagnostics [note]`                      |
| "Use Codex as the runtime for this agent"                | config change to `agentRuntime.id`               |
| "Use my ChatGPT/Codex subscription with normal OpenClaw" | `openai-codex/*` model refs                      |
| "Run Codex through ACP/acpx"                             | ACP `sessions_spawn({ runtime: "acp", ... })`    |
| "Start Claude Code/Gemini/OpenCode/Cursor in a thread"   | ACP/acpx, not `/codex` and not native sub-agents |

OpenClaw only advertises ACP spawn guidance to agents when ACP is enabled,
dispatchable, and backed by a loaded runtime backend. If ACP is not available,
the system prompt and plugin skills should not teach the agent about ACP
routing.

## Codex-only deployments

Force the Codex harness when you need to prove that every embedded agent turn
uses Codex. Explicit plugin runtimes default to no PI fallback, so
`fallback: "none"` is optional but often useful as documentation:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      agentRuntime: {
        id: "codex",
        fallback: "none",
      },
    },
  },
}
```

Environment override:

```bash
OPENCLAW_AGENT_RUNTIME=codex openclaw gateway run
```

With Codex forced, OpenClaw fails early if the Codex plugin is disabled, the
app-server is too old, or the app-server cannot start. Set
`OPENCLAW_AGENT_HARNESS_FALLBACK=pi` only if you intentionally want PI to handle
missing harness selection.

## Per-agent Codex

You can make one agent Codex-only while the default agent keeps normal
auto-selection:

```json5
{
  agents: {
    defaults: {
      agentRuntime: {
        id: "auto",
        fallback: "pi",
      },
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
        agentRuntime: {
          id: "codex",
          fallback: "none",
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

By default, the Codex plugin asks the app-server for available models. If
discovery fails or times out, it uses a bundled fallback catalog for:

- GPT-5.5
- GPT-5.4 mini
- GPT-5.2

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

The managed binary is declared as a bundled plugin runtime dependency and staged
with the rest of the `codex` plugin dependencies. This keeps the app-server
version tied to the bundled plugin instead of whichever separate Codex CLI
happens to be installed locally. Set `appServer.command` only when you
intentionally want to run a different executable.

By default, OpenClaw starts local Codex harness sessions in YOLO mode:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. This is the trusted local operator posture used
for autonomous heartbeats: Codex can use shell and network tools without
stopping on native approval prompts that nobody is around to answer.

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
            serviceTier: "fast",
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
but OpenClaw owns the Codex app-server account bridge. Auth is selected in this
order:

1. An explicit OpenClaw Codex auth profile for the agent.
2. The app-server's existing account, such as a local Codex CLI ChatGPT sign-in.
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

Supported `appServer` fields:

| Field               | Default                                  | Meaning                                                                                                                             |
| ------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `transport`         | `"stdio"`                                | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                                            |
| `command`           | managed Codex binary                     | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                        |
| `args`              | `["app-server", "--listen", "stdio://"]` | Arguments for stdio transport.                                                                                                      |
| `url`               | unset                                    | WebSocket app-server URL.                                                                                                           |
| `authToken`         | unset                                    | Bearer token for WebSocket transport.                                                                                               |
| `headers`           | `{}`                                     | Extra WebSocket headers.                                                                                                            |
| `clearEnv`          | `[]`                                     | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. |
| `requestTimeoutMs`  | `60000`                                  | Timeout for app-server control-plane calls.                                                                                         |
| `mode`              | `"yolo"`                                 | Preset for YOLO or guardian-reviewed execution.                                                                                     |
| `approvalPolicy`    | `"never"`                                | Native Codex approval policy sent to thread start/resume/turn.                                                                      |
| `sandbox`           | `"danger-full-access"`                   | Native Codex sandbox mode sent to thread start/resume.                                                                              |
| `approvalsReviewer` | `"user"`                                 | Use `"auto_review"` to let Codex review native approval prompts. `guardian_subagent` remains a legacy alias.                        |
| `serviceTier`       | unset                                    | Optional Codex app-server service tier: `"fast"`, `"flex"`, or `null`. Invalid legacy values are ignored.                           |

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
      agentRuntime: {
        id: "codex",
        fallback: "none",
      },
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
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      agentRuntime: {
        id: "codex",
      },
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
`PermissionRequest`, and `Stop`. Other Codex hooks such as `SessionStart` and
`UserPromptSubmit` remain Codex-level controls; they are not exposed as
OpenClaw plugin hooks in the v1 contract.

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

| Surface                                       | Support                                 | Why                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI model loop through Codex               | Supported                               | Codex app-server owns the OpenAI turn, native thread resume, and native tool continuation.                                                                                                            |
| OpenClaw channel routing and delivery         | Supported                               | Telegram, Discord, Slack, WhatsApp, iMessage, and other channels stay outside the model runtime.                                                                                                      |
| OpenClaw dynamic tools                        | Supported                               | Codex asks OpenClaw to execute these tools, so OpenClaw stays in the execution path.                                                                                                                  |
| Prompt and context plugins                    | Supported                               | OpenClaw builds prompt overlays and projects context into the Codex turn before starting or resuming the thread.                                                                                      |
| Context engine lifecycle                      | Supported                               | Assemble, ingest or after-turn maintenance, and context-engine compaction coordination run for Codex turns.                                                                                           |
| Dynamic tool hooks                            | Supported                               | `before_tool_call`, `after_tool_call`, and tool-result middleware run around OpenClaw-owned dynamic tools.                                                                                            |
| Lifecycle hooks                               | Supported as adapter observations       | `llm_input`, `llm_output`, `agent_end`, `before_compaction`, and `after_compaction` fire with honest Codex-mode payloads.                                                                             |
| Final-answer revision gate                    | Supported through the native hook relay | Codex `Stop` is relayed to `before_agent_finalize`; `revise` asks Codex for one more model pass before finalization.                                                                                  |
| Native shell, patch, and MCP block or observe | Supported through the native hook relay | Codex `PreToolUse` and `PostToolUse` are relayed for committed native tool surfaces, including MCP payloads on Codex app-server `0.125.0` or newer. Blocking is supported; argument rewriting is not. |
| Native permission policy                      | Supported through the native hook relay | Codex `PermissionRequest` can be routed through OpenClaw policy where the runtime exposes it. If OpenClaw returns no decision, Codex continues through its normal guardian or user approval path.     |
| App-server trajectory capture                 | Supported                               | OpenClaw records the request it sent to app-server and the app-server notifications it receives.                                                                                                      |

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

Codex MCP tool approval elicitations are routed through OpenClaw's plugin
approval flow when Codex marks `_meta.codex_approval_kind` as
`"mcp_tool_call"`. Codex `request_user_input` prompts are sent back to the
originating chat, and the next queued follow-up message answers that native
server request instead of being steered as extra context. Other MCP elicitation
requests still fail closed.

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
new configs. Select an `openai/gpt-*` model with
`agentRuntime.id: "codex"` (or a legacy `codex/*` ref), enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses PI instead of Codex:** `agentRuntime.id: "auto"` can still use PI as the
compatibility backend when no Codex harness claims the run. Set
`agentRuntime.id: "codex"` to force Codex selection while testing. A
forced Codex runtime now fails instead of falling back to PI unless you
explicitly set `agentRuntime.fallback: "pi"`. Once Codex app-server is
selected, its failures surface directly without extra fallback config.

**The app-server is rejected:** upgrade Codex so the app-server handshake
reports version `0.125.0` or newer. Same-version prereleases or build-suffixed
versions such as `0.125.0-alpha.2` or `0.125.0+custom` are rejected because the
stable `0.125.0` protocol floor is what OpenClaw tests.

**Model discovery is slow:** lower `plugins.entries.codex.config.discovery.timeoutMs`
or disable discovery.

**WebSocket transport fails immediately:** check `appServer.url`, `authToken`,
and that the remote app-server speaks the same Codex app-server protocol version.

**A non-Codex model uses PI:** that is expected unless you forced
`agentRuntime.id: "codex"` for that agent or selected a legacy
`codex/*` ref. Plain `openai/gpt-*` and other provider refs stay on their normal
provider path in `auto` mode. If you force `agentRuntime.id: "codex"`, every embedded
turn for that agent must be a Codex-supported OpenAI model.

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
