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

Native Codex turns keep OpenClaw plugin hooks as the public compatibility layer.
These are in-process OpenClaw hooks, not Codex `hooks.json` command hooks:

- `before_prompt_build`
- `before_compaction`, `after_compaction`
- `llm_input`, `llm_output`
- `before_tool_call`, `after_tool_call`
- `before_message_write` for mirrored transcript records
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
`embeddedHarness.runtime: "codex"` or `OPENCLAW_AGENT_RUNTIME=codex` when they
want native app-server execution. Legacy `codex/*` model refs still auto-select
the harness for compatibility, but runtime-backed legacy provider prefixes are
not shown as normal model/provider choices.

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

Legacy `codex/gpt-*` refs remain accepted as compatibility aliases. Doctor
compatibility migration rewrites legacy primary runtime refs to canonical model
refs and records the runtime policy separately, while fallback-only legacy refs
are left unchanged because runtime is configured for the whole agent container.
New PI Codex OAuth configs should use `openai-codex/gpt-*`; new native
app-server harness configs should use `openai/gpt-*` plus
`embeddedHarness.runtime: "codex"`.

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

`/status` shows the effective model runtime. The default PI harness appears as
`Runtime: OpenClaw Pi Default`, and the Codex app-server harness appears as
`Runtime: OpenAI Codex`.

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

## Add Codex alongside other models

Do not set `runtime: "codex"` globally if the same agent should freely switch
between Codex and non-Codex provider models. A forced runtime applies to every
embedded turn for that agent or session. If you select an Anthropic model while
that runtime is forced, OpenClaw still tries the Codex harness and fails closed
instead of silently routing that turn through PI.

Use one of these shapes instead:

- Put Codex on a dedicated agent with `embeddedHarness.runtime: "codex"`.
- Keep the default agent on `runtime: "auto"` and PI fallback for normal mixed
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

## Codex-only deployments

Force the Codex harness when you need to prove that every embedded agent turn
uses Codex. Explicit plugin runtimes default to no PI fallback, so
`fallback: "none"` is optional but often useful as documentation:

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

Supported `appServer` fields:

| Field               | Default                                  | Meaning                                                                                                      |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `transport`         | `"stdio"`                                | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                     |
| `command`           | `"codex"`                                | Executable for stdio transport.                                                                              |
| `args`              | `["app-server", "--listen", "stdio://"]` | Arguments for stdio transport.                                                                               |
| `url`               | unset                                    | WebSocket app-server URL.                                                                                    |
| `authToken`         | unset                                    | Bearer token for WebSocket transport.                                                                        |
| `headers`           | `{}`                                     | Extra WebSocket headers.                                                                                     |
| `requestTimeoutMs`  | `60000`                                  | Timeout for app-server control-plane calls.                                                                  |
| `mode`              | `"yolo"`                                 | Preset for YOLO or guardian-reviewed execution.                                                              |
| `approvalPolicy`    | `"never"`                                | Native Codex approval policy sent to thread start/resume/turn.                                               |
| `sandbox`           | `"danger-full-access"`                   | Native Codex sandbox mode sent to thread start/resume.                                                       |
| `approvalsReviewer` | `"user"`                                 | Use `"auto_review"` to let Codex review native approval prompts. `guardian_subagent` remains a legacy alias. |
| `serviceTier`       | unset                                    | Optional Codex app-server service tier: `"fast"`, `"flex"`, or `null`. Invalid legacy values are ignored.    |

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

Codex-only harness validation:

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      embeddedHarness: {
        runtime: "codex",
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
OpenClaw plugin behavior. For the supported native tool and permission bridge,
OpenClaw injects per-thread Codex config for `PreToolUse`, `PostToolUse`, and
`PermissionRequest`. Other Codex hooks such as `SessionStart`,
`UserPromptSubmit`, and `Stop` remain Codex-level controls; they are not exposed
as OpenClaw plugin hooks in the v1 contract.

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

| Surface                                 | Support                                 | Why                                                                                                                                        |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI model loop through Codex         | Supported                               | Codex app-server owns the OpenAI turn, native thread resume, and native tool continuation.                                                 |
| OpenClaw channel routing and delivery   | Supported                               | Telegram, Discord, Slack, WhatsApp, iMessage, and other channels stay outside the model runtime.                                           |
| OpenClaw dynamic tools                  | Supported                               | Codex asks OpenClaw to execute these tools, so OpenClaw stays in the execution path.                                                       |
| Prompt and context plugins              | Supported                               | OpenClaw builds prompt overlays and projects context into the Codex turn before starting or resuming the thread.                           |
| Context engine lifecycle                | Supported                               | Assemble, ingest or after-turn maintenance, and context-engine compaction coordination run for Codex turns.                                |
| Dynamic tool hooks                      | Supported                               | `before_tool_call`, `after_tool_call`, and tool-result middleware run around OpenClaw-owned dynamic tools.                                 |
| Lifecycle hooks                         | Supported as adapter observations       | `llm_input`, `llm_output`, `agent_end`, `before_compaction`, and `after_compaction` fire with honest Codex-mode payloads.                  |
| Native shell and patch block or observe | Supported through the native hook relay | Codex `PreToolUse` and `PostToolUse` are relayed for the committed native tool surfaces. Blocking is supported; argument rewriting is not. |
| Native permission policy                | Supported through the native hook relay | Codex `PermissionRequest` can be routed through OpenClaw policy where the runtime exposes it.                                              |
| App-server trajectory capture           | Supported                               | OpenClaw records the request it sent to app-server and the app-server notifications it receives.                                           |

Not supported in Codex runtime v1:

| Surface                                             | V1 boundary                                                                                                                                     | Future path                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Native tool argument mutation                       | Codex native pre-tool hooks can block, but OpenClaw does not rewrite Codex-native tool arguments.                                               | Requires Codex hook/schema support for replacement tool input.                                            |
| Editable Codex-native transcript history            | Codex owns canonical native thread history. OpenClaw owns a mirror and can project future context, but should not mutate unsupported internals. | Add explicit Codex app-server APIs if native thread surgery is needed.                                    |
| `tool_result_persist` for Codex-native tool records | That hook transforms OpenClaw-owned transcript writes, not Codex-native tool records.                                                           | Could mirror transformed records, but canonical rewrite needs Codex support.                              |
| Rich native compaction metadata                     | OpenClaw observes compaction start and completion, but does not receive a stable kept/dropped list, token delta, or summary payload.            | Needs richer Codex compaction events.                                                                     |
| Compaction intervention                             | Current OpenClaw compaction hooks are notification-level in Codex mode.                                                                         | Add Codex pre/post compaction hooks if plugins need to veto or rewrite native compaction.                 |
| Stop or final-answer gating                         | Codex has native stop hooks, but OpenClaw does not expose final-answer gating as a v1 plugin contract.                                          | Future opt-in primitive with loop and timeout safeguards.                                                 |
| Native MCP hook parity as a committed v1 surface    | The relay is generic, but OpenClaw has not version-gated and tested native MCP pre/post hook behavior end to end.                               | Add OpenClaw MCP relay tests and docs once the supported app-server protocol floor covers those payloads. |
| Byte-for-byte model API request capture             | OpenClaw can capture app-server requests and notifications, but Codex core builds the final OpenAI API request internally.                      | Needs a Codex model-request tracing event or debug API.                                                   |

## Tools, media, and compaction

The Codex harness changes the low-level embedded agent executor only.

OpenClaw still builds the tool list and receives dynamic tool results from the
harness. Text, images, video, music, TTS, approvals, and messaging-tool output
continue through the normal OpenClaw delivery path.

The native hook relay is intentionally generic, but the v1 support contract is
limited to the Codex-native tool and permission paths that OpenClaw tests. Do not
assume every future Codex hook event is an OpenClaw plugin surface until the
runtime contract names it.

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
`embeddedHarness.runtime: "codex"` (or a legacy `codex/*` ref), enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses PI instead of Codex:** `runtime: "auto"` can still use PI as the
compatibility backend when no Codex harness claims the run. Set
`embeddedHarness.runtime: "codex"` to force Codex selection while testing. A
forced Codex runtime now fails instead of falling back to PI unless you
explicitly set `embeddedHarness.fallback: "pi"`. Once Codex app-server is
selected, its failures surface directly without extra fallback config.

**The app-server is rejected:** upgrade Codex so the app-server handshake
reports version `0.118.0` or newer.

**Model discovery is slow:** lower `plugins.entries.codex.config.discovery.timeoutMs`
or disable discovery.

**WebSocket transport fails immediately:** check `appServer.url`, `authToken`,
and that the remote app-server speaks the same Codex app-server protocol version.

**A non-Codex model uses PI:** that is expected unless you forced
`embeddedHarness.runtime: "codex"` for that agent or selected a legacy
`codex/*` ref. Plain `openai/gpt-*` and other provider refs stay on their normal
provider path in `auto` mode. If you force `runtime: "codex"`, every embedded
turn for that agent must be a Codex-supported OpenAI model.

## Related

- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [Status](/cli/status)
- [Plugin hooks](/plugins/hooks)
- [Configuration reference](/gateway/configuration-reference)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
