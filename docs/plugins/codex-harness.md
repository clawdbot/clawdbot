---
title: "Codex Harness"
summary: "Run OpenClaw embedded agent turns through the bundled Codex app-server harness"
read_when:
  - You want to use the bundled Codex app-server harness
  - You need Codex model refs and config examples
  - You want to disable PI fallback for Codex-only deployments
---

# Codex Harness

The bundled `codex` plugin lets OpenClaw run embedded agent turns through the
Codex app-server instead of the built-in PI harness.

Use this when you want Codex to own the low-level agent session: model
discovery, native thread resume, native compaction, and app-server execution.
OpenClaw still owns chat channels, session files, model selection, tools,
approvals, media delivery, and the visible transcript mirror.

Native Codex turns also respect the shared plugin hooks so prompt shims,
compaction-aware automation, tool middleware, and lifecycle observers stay
aligned with the PI harness:

- `before_prompt_build`
- `before_compaction`, `after_compaction`
- `llm_input`, `llm_output`
- `tool_result`, `after_tool_call`
- `before_message_write`
- `agent_end`

Bundled plugins can also register a Codex app-server extension factory to add
async `tool_result` middleware.

The harness is off by default. It is selected only when the `codex` plugin is
enabled and the resolved model is a `codex/*` model, or when you explicitly
force `embeddedHarness.runtime: "codex"` or `OPENCLAW_AGENT_RUNTIME=codex`.
If you never configure `codex/*`, existing PI, OpenAI, Anthropic, Gemini, local,
and custom-provider runs keep their current behavior.

## Pick the right model prefix

OpenClaw has separate routes for OpenAI and Codex-shaped access:

| Model ref              | Runtime path                                 | Use when                                                                |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `openai/gpt-5.4`       | OpenAI provider through OpenClaw/PI plumbing | You want direct OpenAI Platform API access with `OPENAI_API_KEY`.       |
| `openai-codex/gpt-5.4` | OpenAI Codex OAuth provider through PI       | You want ChatGPT/Codex OAuth without the Codex app-server harness.      |
| `codex/gpt-5.4`        | Bundled Codex provider plus Codex harness    | You want native Codex app-server execution for the embedded agent turn. |

The Codex harness only claims `codex/*` model refs. Existing `openai/*`,
`openai-codex/*`, Anthropic, Gemini, xAI, local, and custom provider refs keep
their normal paths.

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

Use `codex/gpt-5.4`, enable the bundled plugin, and force the `codex` harness:

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
      model: "codex/gpt-5.4",
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

Setting `agents.defaults.model` or an agent model to `codex/<model>` also
auto-enables the bundled `codex` plugin. The explicit plugin entry is still
useful in shared configs because it makes the deployment intent obvious.

## Add Codex without replacing other models

Keep `runtime: "auto"` when you want Codex for `codex/*` models and PI for
everything else:

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
        primary: "codex/gpt-5.4",
        fallbacks: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      },
      models: {
        "codex/gpt-5.4": { alias: "codex" },
        "codex/gpt-5.4-mini": { alias: "codex-mini" },
        "openai/gpt-5.4": { alias: "gpt" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },
      embeddedHarness: {
        runtime: "auto",
        fallback: "pi",
      },
    },
  },
}
```

With this shape:

- `/model codex` or `/model codex/gpt-5.4` uses the Codex app-server harness.
- `/model gpt` or `/model openai/gpt-5.4` uses the OpenAI provider path.
- `/model opus` uses the Anthropic provider path.
- If a non-Codex model is selected, PI remains the compatibility harness.

## Codex-only deployments

Disable PI fallback when you need to prove that every embedded agent turn uses
the Codex harness:

```json5
{
  agents: {
    defaults: {
      model: "codex/gpt-5.4",
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
the requested model is not a `codex/*` ref, the app-server is too old, or the
app-server cannot start.

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
        model: "codex/gpt-5.4",
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
thread as needed. `/reset` clears the OpenClaw session binding for that thread.

## Model discovery

By default, the Codex plugin asks the app-server for available models. If
discovery fails or times out, it uses the bundled fallback catalog:

- `codex/gpt-5.4`
- `codex/gpt-5.4-mini`
- `codex/gpt-5.2`

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

Guardian mode expands to:

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

Guardian is a native Codex approval reviewer. When Codex asks to leave the
sandbox, write outside the workspace, or add permissions such as network access,
Codex routes that approval request to a reviewer subagent instead of a human
prompt. The reviewer gathers context and applies Codex's risk framework, then
approves or denies the specific request. Guardian is useful when you want more
guardrails than YOLO mode but still need unattended agents and heartbeats to
make progress.

The Docker live harness includes a Guardian probe when
`OPENCLAW_LIVE_CODEX_HARNESS_GUARDIAN_PROBE=1`. It starts the Codex harness in
Guardian mode, verifies that a benign escalated shell command is approved, and
verifies that a fake-secret upload to an untrusted external destination is
denied so the agent asks back for explicit approval.

The individual policy fields still win over `mode`, so advanced deployments can
mix the preset with explicit choices.

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
`codex/*` model, provider, approval policy, sandbox, and service tier to
app-server again. Switching from `codex/gpt-5.4` to `codex/gpt-5.2` keeps the
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
currently selected OpenClaw `codex/*` model into app-server, and keeps extended
history enabled.

The command surface requires Codex app-server `0.118.0` or newer. Individual
control methods are reported as `unsupported by this Codex app-server` if a
future or custom app-server does not expose that JSON-RPC method.

## Tools, media, and compaction

The Codex harness changes the low-level embedded agent executor only.

OpenClaw still builds the tool list and receives dynamic tool results from the
harness. Text, images, video, music, TTS, approvals, and messaging-tool output
continue through the normal OpenClaw delivery path.

Codex MCP tool approval elicitations are routed through OpenClaw's plugin
approval flow when Codex marks `_meta.codex_approval_kind` as
`"mcp_tool_call"`; other elicitation and free-form input requests still fail
closed.

When the selected model uses the Codex harness, native thread compaction is
delegated to Codex app-server. OpenClaw keeps a transcript mirror for channel
history, search, `/new`, `/reset`, and future model or harness switching. The
mirror includes the user prompt, final assistant text, and lightweight Codex
reasoning or plan records when the app-server emits them. Today, OpenClaw only
records native compaction start and completion signals. It does not yet expose a
human-readable compaction summary or an auditable list of which entries Codex
kept after compaction.

Media generation does not require PI. Image, video, music, PDF, TTS, and media
understanding continue to use the matching provider/model settings such as
`agents.defaults.imageGenerationModel`, `videoGenerationModel`, `pdfModel`, and
`messages.tts`.

## Troubleshooting

**Codex does not appear in `/model`:** enable `plugins.entries.codex.enabled`,
set a `codex/*` model ref, or check whether `plugins.allow` excludes `codex`.

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

**A non-Codex model uses PI:** that is expected. The Codex harness only claims
`codex/*` model refs.

## Related

- [Agent Harness Plugins](/plugins/sdk-agent-harness)
- [Model Providers](/concepts/model-providers)
- [Configuration Reference](/gateway/configuration-reference)
- [Testing](/help/testing#live-codex-app-server-harness-smoke)
