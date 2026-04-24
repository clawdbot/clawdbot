---
summary: "Run OpenClaw embedded agent turns through the bundled Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the bundled Codex app-server harness
  - You need Codex model refs and config examples
  - You want to disable PI fallback for Codex-only deployments
---

The bundled `codex` plugin lets OpenClaw run embedded agent turns through the
Codex app-server instead of the built-in PI harness.

Use this when you want Codex to own the low-level agent session: model
discovery, native thread resume, native compaction, and app-server execution.
OpenClaw still owns chat channels, session files, model selection, tools,
approvals, media delivery, and the visible transcript mirror.

Native Codex turns keep OpenClaw plugin hooks as the public compatibility layer.
These are in-process OpenClaw hooks, not Codex `hooks.json` command hooks:

- `before_prompt_build`
- `before_compaction`, `after_compaction`
- `llm_input`, `llm_output`
- `after_tool_call`
- `before_message_write` for mirrored transcript records
- `agent_end`

Bundled plugins can also register a Codex app-server extension factory to add
async `tool_result` middleware. That middleware runs for OpenClaw dynamic tools
after OpenClaw executes the tool and before the result is returned to Codex. It
is separate from the public `tool_result_persist` plugin hook, which transforms
OpenClaw-owned transcript tool-result writes.

The harness is off by default. New configs should keep OpenAI model refs
canonical as `openai/gpt-*` and explicitly force
`embeddedHarness.runtime: "codex"` or `OPENCLAW_AGENT_RUNTIME=codex` when they
want native app-server execution. Legacy `codex/*` model refs still auto-select
the harness for compatibility.

## Pick the right model prefix

OpenAI-family routes are prefix-specific. Use `openai-codex/*` when you want
Codex OAuth through PI; use `openai/*` when you want direct OpenAI API access or
when you are forcing the native Codex app-server harness:

| Model ref                                             | Runtime path                                 | Use when                                                                  |
| ----------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `openai/gpt-5.4`                                      | OpenAI provider through OpenClaw/PI plumbing | You want current direct OpenAI Platform API access with `OPENAI_API_KEY`. |
| `openai-codex/gpt-5.5`                                | OpenAI Codex OAuth through OpenClaw/PI       | You want ChatGPT/Codex subscription auth with the default PI runner.      |
| `openai/gpt-5.5` + `embeddedHarness.runtime: "codex"` | Codex app-server harness                     | You want native Codex app-server execution for the embedded agent turn.   |

GPT-5.5 is currently subscription/OAuth-only in OpenClaw. Use
`openai-codex/gpt-5.5` for PI OAuth, or `openai/gpt-5.5` with the Codex
app-server harness. Direct API-key access for `openai/gpt-5.5` is supported
once OpenAI enables GPT-5.5 on the public API.

Legacy `codex/gpt-*` refs remain accepted as compatibility aliases. New PI
Codex OAuth configs should use `openai-codex/gpt-*`; new native app-server
harness configs should use `openai/gpt-*` plus `embeddedHarness.runtime:
"codex"`.

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

Harness selection is not a live session control. When an embedded turn runs,
OpenClaw records the selected harness id on that session and keeps using it for
later turns in the same session id. Change `embeddedHarness` config or
`OPENCLAW_AGENT_RUNTIME` when you want future sessions to use another harness;
use `/new` or `/reset` to start a fresh session before switching an existing
conversation between PI and Codex. This avoids replaying one transcript through
two incompatible native session systems.

Legacy sessions created before harness pins are treated as PI-pinned once they
have transcript history. Use `/new` or `/reset` to opt that conversation into
Codex after changing config.

`/status` shows the effective non-PI harness next to `Fast`, for example
`Fast · codex`. The default PI harness remains `Runner: pi (embedded)` and does
not add a separate harness badge.

## Requirements

- OpenClaw with the bundled `codex` plugin available.
- Codex app-server `0.118.0` or newer.
- Codex auth available to the app-server process.

The plugin blocks older or unversioned app-server handshakes. That keeps
OpenClaw on the protocol surface it has been tested against.

For live and Docker smoke tests, auth usually comes from `OPENAI_API_KEY`, plus
optional Codex CLI files such as `~/.codex/auth.json` and
`~/.codex/config.toml`. Use the same auth material your local Codex app-server
uses.

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
      embeddedHarness: {
        runtime: "codex",
        fallback: "none",
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
prefer `openai/<model>` plus the explicit `embeddedHarness` entry above.

## Add Codex without replacing other models

Keep `runtime: "auto"` when you want legacy `codex/*` refs to select Codex and
PI for everything else. For new configs, prefer explicit `runtime: "codex"` on
the agents that should use the harness.

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
      model: {
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.5", "anthropic/claude-opus-4-6"],
      },
      models: {
        "openai/gpt-5.5": { alias: "gpt" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },
      embeddedHarness: {
        runtime: "codex",
        fallback: "pi",
      },
    },
  },
}
```

With this shape:

- `/model gpt` or `/model openai/gpt-5.5` uses the Codex app-server harness for this config.
- `/model opus` uses the Anthropic provider path.
- If a non-Codex model is selected, PI remains the compatibility harness.

## Codex-only deployments

Disable PI fallback when you need to prove that every embedded agent turn uses
the Codex harness:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      embeddedHarness: {
        runtime: "codex",
        fallback: "none",
      },
    },
  },
}
```

Environment override:

```bash
OPENCLAW_AGENT_RUNTIME=codex \
OPENCLAW_AGENT_HARNESS_FALLBACK=none \
openclaw gateway run
```

With fallback disabled, OpenClaw fails early if the Codex plugin is disabled,
the app-server is too old, or the app-server cannot start.

## Per-agent Codex

You can make one agent Codex-only while the default agent keeps normal
auto-selection:

```json5
{
  agents: {
    defaults: {
      embeddedHarness: {
        runtime: "auto",
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
        embeddedHarness: {
          runtime: "codex",
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

By default, the plugin starts Codex locally with:

```bash
codex app-server --listen stdio://
```

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

Guardian is a native Codex approval reviewer. When Codex asks to leave the sandbox, write outside the workspace, or add permissions like network access, Codex routes that approval request to a reviewer subagent instead of a human prompt. The reviewer applies Codex's risk framework and approves or denies the specific request. Use Guardian when you want more guardrails than YOLO mode but still need unattended agents to make progress.

The `guardian` preset expands to `approvalPolicy: "on-request"`, `approvalsReviewer: "guardian_subagent"`, and `sandbox: "workspace-write"`. Individual policy fields still override `mode`, so advanced deployments can mix the preset with explicit choices.

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

Supported `appServer` fields:

| Field               | Default                                  | Meaning                                                                                                   |
| ------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `transport`         | `"stdio"`                                | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                  |
| `command`           | `"codex"`                                | Executable for stdio transport.                                                                           |
| `args`              | `["app-server", "--listen", "stdio://"]` | Arguments for stdio transport.                                                                            |
| `url`               | unset                                    | WebSocket app-server URL.                                                                                 |
| `authToken`         | unset                                    | Bearer token for WebSocket transport.                                                                     |
| `headers`           | `{}`                                     | Extra WebSocket headers.                                                                                  |
| `requestTimeoutMs`  | `60000`                                  | Timeout for app-server control-plane calls.                                                               |
| `mode`              | `"yolo"`                                 | Preset for YOLO or guardian-reviewed execution.                                                           |
| `approvalPolicy`    | `"never"`                                | Native Codex approval policy sent to thread start/resume/turn.                                            |
| `sandbox`           | `"danger-full-access"`                   | Native Codex sandbox mode sent to thread start/resume.                                                    |
| `approvalsReviewer` | `"user"`                                 | Use `"guardian_subagent"` to let Codex Guardian review prompts.                                           |
| `serviceTier`       | unset                                    | Optional Codex app-server service tier: `"fast"`, `"flex"`, or `null`. Invalid legacy values are ignored. |

The older environment variables still work as fallbacks for local testing when
the matching config field is unset:

- `OPENCLAW_CODEX_APP_SERVER_BIN`
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config is
preferred for repeatable deployments because it keeps the plugin behavior in the
same reviewed file as the rest of the Codex harness setup.

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

Codex-only harness validation, with PI fallback disabled:

```json5
{
  embeddedHarness: {
    fallback: "none",
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
            approvalsReviewer: "guardian_subagent",
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
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.

`/codex resume` writes the same sidecar binding file that the harness uses for
normal turns. On the next message, OpenClaw resumes that Codex thread, passes the
currently selected OpenClaw model into app-server, and keeps extended history
enabled.

The command surface requires Codex app-server `0.118.0` or newer. Individual
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
OpenClaw plugin behavior. Codex native hooks are useful for Codex-owned
operations such as shell policy, native tool result review, stop handling, and
native compaction/model lifecycle, but they are not the OpenClaw plugin API.

For OpenClaw dynamic tools, OpenClaw executes the tool after Codex asks for the
call, so OpenClaw fires the plugin and middleware behavior it owns in the
harness adapter. For Codex-native tools, Codex owns the canonical tool record.
OpenClaw can mirror selected events, but it cannot rewrite the native Codex
thread unless Codex exposes that operation through app-server or native hook
callbacks.

When newer Codex app-server builds expose native compaction and model lifecycle
hook events, OpenClaw should version-gate that protocol support and map the
events into the existing OpenClaw hook contract where the semantics are honest.
Until then, OpenClaw's `before_compaction`, `after_compaction`, `llm_input`, and
`llm_output` events are adapter-level observations, not byte-for-byte captures
of Codex's internal request or compaction payloads.

Codex native `hook/started` and `hook/completed` app-server notifications are
projected as `codex_app_server.hook` agent events for trajectory and debugging.
They do not invoke OpenClaw plugin hooks.

## Tools, media, and compaction

The Codex harness changes the low-level embedded agent executor only.

OpenClaw still builds the tool list and receives dynamic tool results from the
harness. Text, images, video, music, TTS, approvals, and messaging-tool output
continue through the normal OpenClaw delivery path.

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

**Codex does not appear in `/model`:** enable `plugins.entries.codex.enabled`,
select an `openai/gpt-*` model with `embeddedHarness.runtime: "codex"` (or a
legacy `codex/*` ref), and check whether `plugins.allow` excludes `codex`.

**OpenClaw uses PI instead of Codex:** if no Codex harness claims the run,
OpenClaw may use PI as the compatibility backend. Set
`embeddedHarness.runtime: "codex"` to force Codex selection while testing, or
`embeddedHarness.fallback: "none"` to fail when no plugin harness matches. Once
Codex app-server is selected, its failures surface directly without extra
fallback config.

**The app-server is rejected:** upgrade Codex so the app-server handshake
reports version `0.118.0` or newer.

**Model discovery is slow:** lower `plugins.entries.codex.config.discovery.timeoutMs`
or disable discovery.

**WebSocket transport fails immediately:** check `appServer.url`, `authToken`,
and that the remote app-server speaks the same Codex app-server protocol version.

**A non-Codex model uses PI:** that is expected unless you forced
`embeddedHarness.runtime: "codex"` (or selected a legacy `codex/*` ref). Plain
`openai/gpt-*` and other provider refs stay on their normal provider path.

## Related

- [Agent Harness Plugins](/plugins/sdk-agent-harness)
- [Model Providers](/concepts/model-providers)
- [Configuration Reference](/gateway/configuration-reference)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
