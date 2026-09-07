---
summary: "Setting up ACP agents: acpx harness config, plugin setup, permissions"
read_when:
  - Installing or configuring the acpx harness for Claude Code / Codex / Gemini CLI
  - Enabling the plugin-tools or OpenClaw-tools MCP bridge
  - Configuring ACP permission modes
title: "ACP agents — setup"
---

For the overview, operator runbook, and concepts, see [ACP agents](/tools/acp-agents).

This page covers acpx harness config, plugin setup for the MCP bridges, and permission configuration.

Use this page only when you are setting up the ACP/acpx route. For native Codex
app-server runtime config, use [Codex harness](/plugins/codex-harness). For
OpenAI API keys or Codex OAuth model-provider config, use
[OpenAI](/providers/openai).

Codex has two OpenClaw routes:

| Route                      | Config/command                                         | Setup page                              |
| -------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Native Codex app-server    | `/codex ...`, `openai/gpt-*` agent refs                | [Codex harness](/plugins/codex-harness) |
| Explicit Codex ACP adapter | `/acp spawn codex`, `runtime: "acp", agentId: "codex"` | This page                               |

Prefer the native route unless you explicitly need ACP/acpx behavior.

## acpx harness support (current)

Built-in acpx harness aliases (from the pinned `acpx` dependency):

| Alias        | Wraps                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `claude`     | [Claude Code](https://claude.ai/code)                                                                  |
| `codex`      | [Codex CLI](https://developers.openai.com/codex/cli)                                                   |
| `copilot`    | [GitHub Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli) |
| `cursor`     | [Cursor CLI](https://cursor.com/docs/cli/acp) (`cursor-agent acp`)                                     |
| `droid`      | [Factory Droid](https://www.factory.ai)                                                                |
| `fast-agent` | [fast-agent](https://fast-agent.ai)                                                                    |
| `gemini`     | [Gemini CLI](https://github.com/google-gemini/gemini-cli)                                              |
| `iflow`      | [iFlow CLI](https://github.com/iflow-ai/iflow-cli)                                                     |
| `kilocode`   | [Kilocode](https://kilocode.ai)                                                                        |
| `kimi`       | [Kimi CLI](https://github.com/MoonshotAI/kimi-cli)                                                     |
| `kiro`       | [Kiro CLI](https://kiro.dev)                                                                           |
| `mux`        | [Mux](https://mux.coder.com)                                                                           |
| `opencode`   | [OpenCode](https://opencode.ai)                                                                        |
| `openclaw`   | OpenClaw ACP bridge (native `openclaw acp`)                                                            |
| `pi`         | [Pi Coding Agent](https://github.com/earendil-works/pi)                                                |
| `qoder`      | [Qoder CLI](https://docs.qoder.com/cli/acp)                                                            |
| `qwen`       | [Qwen Code](https://github.com/QwenLM/qwen-code)                                                       |
| `trae`       | [Trae CLI](https://docs.trae.cn/cli)                                                                   |

`factory-droid` and `factorydroid` also resolve to the built-in `droid` adapter.

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.
If your local Cursor install still exposes ACP as `agent acp`, override the `cursor` agent command in your acpx config instead of changing the built-in default.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

Model control is adapter-capability dependent. Codex ACP model refs are
normalized by OpenClaw before startup. Other harnesses need ACP `models` plus
`session/set_model` support; if a harness exposes neither that ACP capability
nor its own startup model flag, OpenClaw/acpx cannot force a model selection.

## Required config

Core ACP baseline:

```json5
{
  acp: {
    enabled: true,
    // Optional. Default is true; set false to pause ACP dispatch while keeping /acp controls.
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "droid",
      "gemini",
      "iflow",
      "kilocode",
      "kimi",
      "kiro",
      "openclaw",
      "opencode",
      "qwen",
    ],
    stream: {
      deliveryMode: "live",
    },
  },
}
```

Thread binding config is shared across supported channel adapters:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
      spawnSessions: true,
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `session.threadBindings.spawnSessions=true`

Current-conversation binds do not require child-thread creation. They require an active conversation context and a channel adapter that exposes ACP conversation bindings.

See [Configuration Reference](/gateway/configuration-reference).

## Repair existing bare-session histories

ACPX isolates bare session names by OpenClaw owner. If a session reports
`SESSION_OWNER_MIGRATION_REQUIRED`, stop the Gateway and run
`openclaw doctor --fix`, then restart. Doctor uses the same service workspace
as the Gateway; ACPX's default state directory is `<service workspace>/state`.

The repair requires one current, unambiguous canonical owner claim with matching
backend identifiers. It preserves the raw history, event-log references, upstream
session IDs, timestamps, options, and usage. Persistent record names move to an
owner-qualified resource; existing oneshot physical IDs and histories remain intact.
Ambiguous, stale, conflicting, unreadable, or live records remain in place with a
diagnostic. Resolve the reported evidence problem before retrying; resetting the
session does not bypass this repair.

This is an offline, crash-recoverable migration with atomic destination-file
publication. Files and SQLite are not one atomic transaction. Interrupted repairs
can be rerun: Doctor checks the existing destination and canonical claim before
finishing the metadata update and archiving the old persistent record.

## Plugin setup for acpx backend

Packaged installs use the official `@openclaw/acpx` runtime plugin for ACP.
Install and enable it before using ACP harness sessions:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Source checkouts can also use the local workspace plugin after `pnpm install`.

Start with:

```text
/acp doctor
```

If you disabled `acpx`, denied it via `plugins.allow` / `plugins.deny`, or want
to switch back to the packaged plugin, use the explicit package path:

```bash
openclaw plugins install @openclaw/acpx
openclaw config set plugins.entries.acpx.enabled true
```

Local workspace install during development:

```bash
openclaw plugins install ./path/to/local/acpx-plugin
```

Then verify backend health:

```text
/acp doctor
```

### acpx runtime startup probe

The `acpx` plugin embeds the ACP runtime directly (no separate `acpx` binary or
version to configure). By default it registers the embedded backend during
Gateway startup and waits for one health probe before the gateway `ready`
signal. That probe also supplies failure diagnostics and is bounded by
`plugins.entries.acpx.config.timeoutSeconds`; an unhealthy result does not
launch a second probe. Set `OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE=0` or
`OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1` only for scripts or environments that
intentionally keep the startup probe disabled. Run `/acp doctor` for an explicit
on-demand probe.

Override an individual ACP agent command with structured arguments when a path
or flag value should remain one argv token:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "agents": {
            "claude": {
              "command": "node",
              "args": ["/path/to/custom adapter.mjs", "--verbose"]
            }
          }
        }
      }
    }
  }
}
```

- `agents.<id>.command` is the executable or existing command string for that ACP agent. An existing absolute executable path stays one argument even when it contains spaces.
- `agents.<id>.args` is optional. Each item is passed unchanged, including empty strings, spaces, quotes, and backslashes. Do not add shell quoting inside the array.

On Windows, put the executable path in `command` and its flags in `args`.
Quote relative executable paths containing spaces when using a command string.
Generated adapter wrappers also use argv arrays. Reconnecting an unchanged
session preserves its saved command representation and conversation history.

See [Plugins](/tools/plugin).

### Automatic adapter download

`acpx` auto-downloads ACP adapters (for example the Claude and Codex ACP
bridges) via `npx` on first use. You do not need to install adapter packages
manually, and there is no separate postinstall step for OpenClaw itself. If an
adapter download or spawn fails, `/acp doctor` reports the failure.

### Plugin tools MCP bridge

By default, ACPX sessions do **not** expose OpenClaw plugin-registered tools to
the ACP harness.

If you want ACP agents such as Codex or Claude Code to call installed
OpenClaw plugin tools such as memory recall/store, enable the dedicated bridge:

```bash
openclaw config set plugins.entries.acpx.config.pluginToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-plugin-tools` into ACPX session
  bootstrap.
- Exposes plugin tools already registered by installed and enabled OpenClaw
  plugins.
- Passes the active ACP session identity to plugin tool factories, so
  agent-scoped tools stay in that agent's namespace.
- Keeps the feature explicit and default-off.

Security and trust notes:

- This expands the ACP harness tool surface.
- ACP agents get access only to plugin tools already active in the gateway.
- Treat this as the same trust boundary as letting those plugins execute in
  OpenClaw itself.
- Review installed plugins before enabling it.

Custom `mcpServers` still work as before. The built-in plugin-tools bridge is an
additional opt-in convenience, not a replacement for generic MCP server config.

### OpenClaw tools MCP bridge

By default, ACPX sessions also do **not** expose built-in OpenClaw tools through
MCP. Enable the separate core-tools bridge when an ACP agent needs selected
built-in tools such as `cron`:

```bash
openclaw config set plugins.entries.acpx.config.openClawToolsMcpBridge true
```

What this does:

- Injects a built-in MCP server named `openclaw-tools` into ACPX session
  bootstrap.
- Exposes selected built-in OpenClaw tools. The initial server exposes `cron`.
- Keeps core-tool exposure explicit and default-off.

### Runtime operation timeout configuration

The `acpx` plugin gives embedded runtime startup and control operations 120
seconds by default. This gives slower harnesses such as Gemini CLI enough time
to complete ACP startup and initialization. Override it if your host needs a
different operation limit:

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

Runtime turns use OpenClaw agent/run timeouts, including `/acp timeout`.
`sessions_spawn` does not accept per-call timeout overrides; the operator path
is `agents.defaults.subagents.runTimeoutSeconds`. Restart the gateway after
changing `timeoutSeconds`.

### Health probe agent configuration

When `/acp doctor` or the startup probe checks the backend, the bundled `acpx`
plugin probes one harness agent. If `acp.allowedAgents` is set, it defaults to
the first allowed agent; otherwise it defaults to `codex`. If your deployment
needs a different ACP agent for health checks, set the probe agent explicitly:

```bash
openclaw config set plugins.entries.acpx.config.probeAgent claude
```

Restart the gateway after changing this value.

## Permission configuration

ACP sessions run without an interactive TTY for file-write and shell-exec
permission prompts. This does not disable ACP form or URL elicitation during a
channel-delivered turn: those requests use transient Gateway questions instead.
The acpx plugin provides two config keys that control harness permissions:

These ACPX harness permissions are separate from OpenClaw exec approvals and separate from CLI-backend vendor bypass flags such as Claude CLI `--permission-mode bypassPermissions`. ACPX `approve-all` is the harness-level break-glass switch for ACP sessions.

For the broader comparison between OpenClaw `tools.exec.mode`, Codex Guardian
approvals, and ACPX harness permissions, see
[Permission modes](/tools/permission-modes).

### `permissionMode`

Controls which operations the harness agent can perform without prompting.

| Value           | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | Auto-approve all file writes and shell commands.          |
| `approve-reads` | Auto-approve reads only; writes and exec require prompts. |
| `deny-all`      | Deny all permission prompts.                              |

### `nonInteractivePermissions`

Controls what happens when a permission prompt would be shown but no interactive TTY is available (which is always the case for ACP sessions).

| Value  | Behavior                                                                 |
| ------ | ------------------------------------------------------------------------ |
| `fail` | Abort the session with `PermissionPromptUnavailableError`. **(default)** |
| `deny` | Silently deny the permission and continue (graceful degradation).        |

### Configuration

Set via plugin config:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

Restart the gateway after changing these values.

<Warning>
OpenClaw defaults to `permissionMode=approve-reads` and `nonInteractivePermissions=fail`. In non-interactive ACP sessions, any write or exec that triggers a permission prompt can fail with `PermissionPromptUnavailableError: Permission prompt unavailable in non-interactive mode`.

If you need to restrict permissions, set `nonInteractivePermissions` to `deny` so sessions degrade gracefully instead of crashing.
</Warning>

## Related

- [ACP agents](/tools/acp-agents) — overview, operator runbook, concepts
- [Sub-agents](/tools/subagents)
- [Multi-agent routing](/concepts/multi-agent)
