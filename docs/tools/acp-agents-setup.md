---
summary: "Setting up ACP agents: acpx harness config, plugin setup, permissions"
read_when:
  - Installing or configuring the acpx harness for Claude Code / Codex / Gemini CLI
  - Enabling the plugin-tools or OpenClaw-tools MCP bridge
  - Configuring ACP permission modes
title: "ACP agents — setup"
---

For the overview, operator runbook, and concepts, see [ACP agents](/tools/acp-agents).

The sections below cover acpx harness config, plugin setup for the MCP bridges, and permission configuration.

## acpx harness support (current)

Current acpx built-in harness aliases:

- `claude`
- `codex`
- `copilot`
- `cursor` (Cursor CLI: `cursor-agent acp`)
- `droid`
- `gemini`
- `iflow`
- `kilocode`
- `kimi`
- `kiro`
- `openclaw`
- `opencode`
- `pi`
- `qwen`

When OpenClaw uses the acpx backend, prefer these values for `agentId` unless your acpx config defines custom agent aliases.
If your local Cursor install still exposes ACP as `agent acp`, override the `cursor` agent command in your acpx config instead of changing the built-in default.

Direct acpx CLI usage can also target arbitrary adapters via `--agent <command>`, but that raw escape hatch is an acpx CLI feature (not the normal OpenClaw `agentId` path).

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
      "pi",
      "qwen",
    ],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200,
    },
    runtime: {
      ttlMinutes: 120,
    },
  },
}
```

Thread binding config is channel-adapter specific. Example for Discord:

```json5
{
  session: {
    threadBindings: {
      enabled: true,
      idleHours: 24,
      maxAgeHours: 0,
    },
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
      },
    },
  },
}
```

If thread-bound ACP spawn does not work, verify the adapter feature flag first:

- Discord: `channels.discord.threadBindings.spawnAcpSessions=true`

Current-conversation binds do not require child-thread creation. They require an active conversation context and a channel adapter that exposes ACP conversation bindings.

See [Configuration Reference](/gateway/configuration-reference).

## Plugin setup for acpx backend

Fresh installs ship the bundled `acpx` runtime plugin enabled by default, so ACP
usually works without a manual plugin install step.

Start with:

```text
/acp doctor
```

If you disabled `acpx`, denied it via `plugins.allow` / `plugins.deny`, or want
to switch to a local development checkout, use the explicit plugin path:

```bash
openclaw plugins install acpx
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

### acpx command and version configuration

By default, the bundled `acpx` plugin uses its plugin-local pinned binary (`node_modules/.bin/acpx` inside the plugin package). Startup registers the backend as not-ready and a background job verifies `acpx --version`; if the binary is missing or mismatched, it runs `npm install --omit=dev --no-save acpx@<pinned>` and re-verifies. The gateway stays non-blocking throughout.

Override the command or version in plugin config:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "command": "../acpx/dist/cli.js",
          "expectedVersion": "any"
        }
      }
    }
  }
}
```

- `command` accepts an absolute path, relative path (resolved from the OpenClaw workspace), or command name.
- `expectedVersion: "any"` disables strict version matching.
- Custom `command` paths disable plugin-local auto-install.

See [Plugins](/tools/plugin).

### Automatic dependency install

When you install OpenClaw globally with `npm install -g openclaw`, the acpx
runtime dependencies (platform-specific binaries) are installed automatically
via a postinstall hook. If the automatic install fails, the gateway still starts
normally and reports the missing dependency through `openclaw acp doctor`.

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

### Runtime timeout configuration

The bundled `acpx` plugin defaults embedded runtime turns to a 120-second
timeout. This gives slower harnesses such as Gemini CLI enough time to complete
ACP startup and initialization. Override it if your host needs a different
runtime limit:

```bash
openclaw config set plugins.entries.acpx.config.timeoutSeconds 180
```

Restart the gateway after changing this value.

### Health probe agent configuration

The bundled `acpx` plugin probes one harness agent while deciding whether the
embedded runtime backend is ready. If `acp.allowedAgents` is set, it defaults to
the first allowed agent; otherwise it defaults to `codex`. If your deployment
needs a different ACP agent for health checks, set the probe agent explicitly:

```bash
openclaw config set plugins.entries.acpx.config.probeAgent claude
```

Restart the gateway after changing this value.

## Permission configuration

ACP sessions run non-interactively — there is no TTY to approve or deny file-write and shell-exec permission prompts. The acpx plugin provides two config keys that control how permissions are handled:

These ACPX harness permissions are separate from OpenClaw exec approvals and separate from CLI-backend vendor bypass flags such as Claude CLI `--permission-mode bypassPermissions`. ACPX `approve-all` is the harness-level break-glass switch for ACP sessions.

### `permissionMode`

Controls which operations the harness agent can perform without prompting.

| Value           | Behavior                                                  |
| --------------- | --------------------------------------------------------- |
| `approve-all`   | Auto-approve all file writes and shell commands.          |
| `approve-reads` | Auto-approve reads only; writes and exec require prompts. |
| `deny-all`      | Deny all permission prompts.                              |

### `nonInteractivePermissions`

Controls what happens when a permission prompt would be shown but no interactive TTY is available (which is always the case for ACP sessions).

| Value  | Behavior                                                          |
| ------ | ----------------------------------------------------------------- |
| `fail` | Abort the session with `AcpRuntimeError`. **(default)**           |
| `deny` | Silently deny the permission and continue (graceful degradation). |

### Configuration

Set via plugin config:

```bash
openclaw config set plugins.entries.acpx.config.permissionMode approve-all
openclaw config set plugins.entries.acpx.config.nonInteractivePermissions fail
```

Restart the gateway after changing these values.

> **Important:** OpenClaw currently defaults to `permissionMode=approve-reads` and `nonInteractivePermissions=fail`. In non-interactive ACP sessions, any write or exec that triggers a permission prompt can fail with `AcpRuntimeError: Permission prompt unavailable in non-interactive mode`.
>
> If you need to restrict permissions, set `nonInteractivePermissions` to `deny` so sessions degrade gracefully instead of crashing.

## Related

- [ACP agents](/tools/acp-agents) — overview, operator runbook, concepts
- [Sub-agents](/tools/subagents)
- [Multi-agent routing](/concepts/multi-agent)
