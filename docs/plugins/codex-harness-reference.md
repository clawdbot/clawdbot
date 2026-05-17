---
summary: "Configuration, auth, discovery, and app-server reference for the Codex harness"
title: "Codex harness reference"
read_when:
  - You need every Codex harness config field
  - You are changing app-server transport, auth, discovery, or timeout behavior
  - You are debugging Codex harness startup, model discovery, or environment isolation
---

This reference covers the detailed configuration for the bundled `codex`
plugin. For setup and routing decisions, start with
[Codex harness](/plugins/codex-harness).

## Plugin config surface

All Codex harness settings live under `plugins.entries.codex.config`.

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
          appServer: {
            mode: "guardian",
          },
        },
      },
    },
  },
}
```

Supported top-level fields:

| Field                      | Default                  | Meaning                                                                                                                                   |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery`                | enabled                  | Model discovery settings for Codex app-server `model/list`.                                                                               |
| `appServer`                | managed stdio app-server | Transport, command, auth, approval, sandbox, and timeout settings.                                                                        |
| `codexDynamicToolsLoading` | `"searchable"`           | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context.                                                  |
| `codexDynamicToolsExclude` | `[]`                     | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.                                                               |
| `codexPlugins`             | disabled                 | Native Codex plugin/app support for migrated source-installed curated plugins. See [Native Codex plugins](/plugins/codex-native-plugins). |
| `computerUse`              | disabled                 | Codex Computer Use setup. See [Codex Computer Use](/plugins/codex-computer-use).                                                          |

## App-server transport

By default, OpenClaw starts the managed Codex binary shipped with the bundled
plugin:

```bash
codex app-server --listen stdio://
```

This keeps the app-server version tied to the bundled `codex` plugin instead of
whichever separate Codex CLI happens to be installed locally. Set
`appServer.command` only when you intentionally want to run a different
executable.

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
            url: "ws://gateway-host:39175",
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

| Field                         | Default                                                | Meaning                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                   | `"stdio"`                                              | `"stdio"` spawns Codex; `"websocket"` connects to `url`.                                                                                                                                        |
| `command`                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary.                                                                                                                          |
| `args`                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                  |
| `url`                         | unset                                                  | WebSocket app-server URL.                                                                                                                                                                       |
| `authToken`                   | unset                                                  | Bearer token for WebSocket transport.                                                                                                                                                           |
| `headers`                     | `{}`                                                   | Extra WebSocket headers.                                                                                                                                                                        |
| `clearEnv`                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment.                                                             |
| `requestTimeoutMs`            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                     |
| `turnCompletionIdleTimeoutMs` | `60000`                                                | Quiet window after Codex accepts a turn or after a turn-scoped app-server request while OpenClaw waits for `turn/completed`.                                                                    |
| `mode`                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution.                                                                                                                                                 |
| `approvalPolicy`              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start, resume, and turn.                                                                                                                            |
| `sandbox`                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start and resume.                                                                                                                                      |
| `approvalsReviewer`           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed.                                                                                                                   |
| `defaultWorkspaceDir`         | current process directory                              | Workspace used by `/codex bind` when `--cwd` is omitted.                                                                                                                                        |
| `serviceTier`                 | unset                                                  | Optional Codex app-server service tier. `"priority"` enables fast-mode routing, `"flex"` requests flex processing, and `null` clears the override. Legacy `"fast"` is accepted as `"priority"`. |

The plugin blocks older or unversioned app-server handshakes. Codex app-server
must report stable version `0.125.0` or newer.

## Approval and sandbox modes

Local stdio app-server sessions default to YOLO mode:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. This trusted local operator posture lets
unattended OpenClaw turns and heartbeats make progress without native approval
prompts that nobody is around to answer.

If Codex's local system requirements file disallows implicit YOLO approval,
reviewer, or sandbox values, OpenClaw treats the implicit default as guardian
instead and selects allowed guardian permissions. Hostname-matching
`[[remote_sandbox_config]]` entries in the same requirements file are honored
for the sandbox default decision.

Set `appServer.mode: "guardian"` for Codex guardian-reviewed approvals:

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

The `guardian` preset expands to `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"` when those
values are allowed. Individual policy fields override `mode`. The older
`guardian_subagent` reviewer value is still accepted as a compatibility alias,
but new configs should use `auto_review`.

## Auth and environment isolation

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

Stdio app-server launches inherit OpenClaw's process environment by default.
OpenClaw owns the Codex app-server account bridge and sets `CODEX_HOME` to a
per-agent directory under that agent's OpenClaw state. That keeps Codex config,
accounts, plugin cache/data, and thread state scoped to the OpenClaw agent
instead of leaking in from the operator's personal `~/.codex` home.

OpenClaw does not rewrite `HOME` for normal local app-server launches. Codex-run
subprocesses such as `openclaw`, `gh`, `git`, cloud CLIs, and shell commands see
the normal process home and can find user-home config and tokens. Codex may also
discover `$HOME/.agents/skills` and `$HOME/.agents/plugins/marketplace.json`;
that `.agents` discovery is intentionally shared with the operator home and is
separate from isolated `~/.codex` state.

OpenClaw plugins and OpenClaw skill snapshots still flow through OpenClaw's own
plugin registry and skill loader. Personal Codex `~/.codex` assets do not. If
you have useful Codex CLI skills or plugins from a Codex home that should become
part of an OpenClaw agent, inventory them explicitly:

```bash
openclaw migrate codex --dry-run
openclaw migrate apply codex --yes
```

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

## Dynamic tools

Codex dynamic tools default to `searchable` loading. OpenClaw does not expose
dynamic tools that duplicate Codex-native workspace operations:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `update_plan`

Remaining OpenClaw integration tools, such as messaging, sessions, media, cron,
browser, nodes, gateway, `heartbeat_respond`, and `web_search`, are available
through Codex tool search under the `openclaw` namespace. This keeps the initial
model context smaller. `sessions_yield` and message-tool-only source replies
stay direct because those are turn-control contracts.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom Codex
app-server that cannot search deferred dynamic tools or when debugging the full
tool payload.

## Timeouts

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`. Each Codex `item/tool/call` request uses the first
available timeout in this order:

- A positive per-call `timeoutMs` argument.
- For `image_generate`, `agents.defaults.imageGenerationModel.timeoutMs`.
- For the media-understanding `image` tool, `tools.media.image.timeoutSeconds`
  converted to milliseconds, or the 60 second media default.
- The 30 second dynamic-tool default.

Dynamic tool budgets are capped at 600000 ms. On timeout, OpenClaw aborts the
tool signal where supported and returns a failed dynamic-tool response to Codex
so the turn can continue instead of leaving the session in `processing`.

After Codex accepts a turn, and after OpenClaw responds to a turn-scoped
app-server request, the harness expects Codex to make current-turn progress and
eventually finish the native turn with `turn/completed`. If the app-server goes
quiet for `appServer.turnCompletionIdleTimeoutMs`, OpenClaw best-effort
interrupts the Codex turn, records a diagnostic timeout, and releases the
OpenClaw session lane so follow-up chat messages are not queued behind a stale
native turn.

Most non-terminal notifications for the same turn disarm that short watchdog
because Codex has proven the turn is still alive. Raw `custom_tool_call_output`
completions keep the short post-tool watchdog armed because they are the
turn-scoped tool-result handoff. Completed `agentMessage` items and pre-tool raw
assistant `rawResponseItem/completed` items arm the assistant-output release: if
Codex then goes quiet without `turn/completed`, OpenClaw best-effort interrupts
the native turn and releases the session lane. Post-tool raw assistant progress
keeps waiting for `turn/completed` or the terminal watchdog. Timeout diagnostics
include the last app-server notification method and, for raw assistant response
items, the item type, role, id, and a bounded assistant text preview.

## Model discovery

By default, the Codex plugin asks the app-server for available models. Model
availability is owned by Codex app-server, so the list can change when OpenClaw
upgrades the bundled `@openai/codex` version or when a deployment points
`appServer.command` at a different Codex binary. Availability can also be
account-scoped. Use `/codex models` on a running gateway to see the live catalog
for that harness and account.

If discovery fails or times out, OpenClaw uses a bundled fallback catalog for:

- GPT-5.5
- GPT-5.4 mini
- GPT-5.2

The current bundled harness is `@openai/codex` `0.130.0`. A `model/list` probe
against that bundled app-server returned:

| Model id              | Default | Hidden | Input modalities | Reasoning efforts        |
| --------------------- | ------- | ------ | ---------------- | ------------------------ |
| `gpt-5.5`             | Yes     | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.4`             | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.4-mini`        | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.3-codex`       | No      | No     | text, image      | low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | No      | No     | text             | low, medium, high, xhigh |
| `gpt-5.2`             | No      | No     | text, image      | low, medium, high, xhigh |

Hidden models can be returned by the app-server catalog for internal or
specialized flows, but they are not normal model-picker choices.

Tune discovery under `plugins.entries.codex.config.discovery`:

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

Disable discovery when you want startup to avoid probing Codex and use only the
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

## Workspace bootstrap files

Codex handles `AGENTS.md` itself through native project-doc discovery. OpenClaw
does not write synthetic Codex project-doc files or depend on Codex fallback
filenames for persona files, because Codex fallbacks only apply when
`AGENTS.md` is missing.

For OpenClaw workspace parity, the Codex harness resolves the other bootstrap
files, including `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`,
`HEARTBEAT.md`, `BOOTSTRAP.md`, and `MEMORY.md` when present, and forwards them
through Codex developer instructions on `thread/start` and `thread/resume`.
This keeps workspace persona and profile context visible on the native Codex
behavior-shaping lane without duplicating `AGENTS.md`.

## Environment overrides

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

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [OpenAI provider](/providers/openai)
- [Configuration reference](/gateway/configuration-reference)
