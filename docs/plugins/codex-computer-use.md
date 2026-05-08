---
summary: "Set up Codex Computer Use for Codex-mode OpenClaw agents"
title: "Codex Computer Use"
read_when:
  - You want Codex-mode OpenClaw agents to use Codex Computer Use
  - You are deciding between Codex Computer Use, PeekabooBridge, and direct cua-driver MCP
  - You are deciding between Codex Computer Use and a direct cua-driver MCP setup
  - You are configuring computerUse for the bundled Codex plugin
  - You are troubleshooting /codex computer-use status or install
---

Computer Use is a Codex-native MCP plugin for local desktop control. OpenClaw
does not vendor the desktop app, execute desktop actions itself, or bypass
Codex permissions. The bundled `codex` plugin only prepares Codex app-server:
it enables Codex plugin support, finds or installs the configured Codex
Computer Use plugin, checks that the `computer-use` MCP server is available, and
then lets Codex own the native MCP tool calls during Codex-mode turns.

Use this page when OpenClaw is already using the native Codex harness. For the
runtime setup itself, see [Codex harness](/plugins/codex-harness).

## OpenClaw.app and Peekaboo

OpenClaw.app's Peekaboo integration is separate from Codex Computer Use. The
macOS app can host a PeekabooBridge socket so the `peekaboo` CLI can reuse the
app's local Accessibility and Screen Recording grants for Peekaboo's own
automation tools. That bridge does not install or proxy Codex Computer Use, and
Codex Computer Use does not call through the PeekabooBridge socket.

Use [Peekaboo bridge](/platforms/mac/peekaboo) when you want OpenClaw.app to be
a permission-aware host for Peekaboo CLI automation. Use this page when a
Codex-mode OpenClaw agent should have Codex's native `computer-use` MCP plugin
available before the turn starts.

## iOS app

The iOS app is separate from Codex Computer Use. It does not install or proxy
the Codex `computer-use` MCP server and it is not a desktop-control backend.
Instead, the iOS app connects as an OpenClaw node and exposes mobile
capabilities through node commands such as `canvas.*`, `camera.*`, `screen.*`,
`location.*`, and `talk.*`.

Use [iOS](/platforms/ios) when you want an agent to drive an iPhone node through
the gateway. Use this page when a Codex-mode agent should control the local
macOS desktop through Codex's native Computer Use plugin.

## Direct cua-driver MCP

Codex Computer Use is not the only way to expose desktop control. If you want
OpenClaw-managed runtimes to call TryCua's driver directly, use the upstream
`cua-driver mcp` server through OpenClaw's MCP registry instead of the
Codex-specific marketplace flow.

After installing `cua-driver`, either ask it for the OpenClaw command:

```bash
cua-driver mcp-config --client openclaw
```

or register the stdio server yourself:

```bash
openclaw mcp set cua-driver '{"command":"cua-driver","args":["mcp"]}'
```

That path keeps the upstream MCP tool surface intact, including the driver
schemas and structured MCP responses. Use it when you want the CUA driver
available as a normal OpenClaw MCP server. Use the Codex Computer Use setup on
this page when Codex app-server should own plugin installation, MCP reloads,
and native tool calls inside Codex-mode turns.

CUA's driver is macOS-specific and still requires the local macOS permissions
that its app prompts for, such as Accessibility and Screen Recording. OpenClaw
does not install `cua-driver`, grant those permissions, or bypass the upstream
driver's safety model.

## Quick setup

Set `plugins.entries.codex.config.computerUse` when Codex-mode turns must have
Computer Use available before a thread starts:

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

With this config, OpenClaw checks Codex app-server before each Codex-mode turn.
If Computer Use is missing but Codex app-server has already discovered an
installable marketplace, OpenClaw asks Codex app-server to install or re-enable
the plugin and reload MCP servers. On macOS, when no matching marketplace is
registered and the standard Codex app bundle exists, OpenClaw also tries to
register the bundled Codex marketplace from
`/Applications/Codex.app/Contents/Resources/plugins/openai-bundled` before it
fails. If setup still cannot make the MCP server available, the turn fails
before the thread starts.

After changing Computer Use config, use `/new` or `/reset` in the affected chat
before testing if an existing Codex thread has already started.

## Commands

Use the `/codex computer-use` commands from any chat surface where the `codex`
plugin command surface is available. These are OpenClaw chat/runtime commands,
not `openclaw codex ...` CLI subcommands:

```text
/codex computer-use status
/codex computer-use install
/codex computer-use install --source <marketplace-source>
/codex computer-use install --marketplace-path <path>
/codex computer-use install --marketplace <name>
```

`status` is read-only. It does not add marketplace sources, install plugins, or
enable Codex plugin support.

`install` enables Codex app-server plugin support, optionally adds a configured
marketplace source, installs or re-enables the configured plugin through Codex
app-server, reloads MCP servers, and verifies that the MCP server exposes tools.

## Marketplace choices

OpenClaw uses the same app-server API that Codex itself exposes. The
marketplace fields choose where Codex should find `computer-use`.

| Field                | Use when                                                        | Install support                                          |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| No marketplace field | You want Codex app-server to use marketplaces it already knows. | Yes, when app-server returns a local marketplace.        |
| `marketplaceSource`  | You have a Codex marketplace source app-server can add.         | Yes, for explicit `/codex computer-use install`.         |
| `marketplacePath`    | You already know the local marketplace file path on the host.   | Yes, for explicit install and turn-start auto-install.   |
| `marketplaceName`    | You want to select one already registered marketplace by name.  | Yes only when the selected marketplace has a local path. |

Fresh Codex homes may need a short moment to seed their official marketplaces.
During install, OpenClaw polls `plugin/list` for up to
`marketplaceDiscoveryTimeoutMs` milliseconds. The default is 60 seconds.

If multiple known marketplaces contain Computer Use, OpenClaw prefers
`openai-bundled`, then `openai-curated`, then `local`. Unknown ambiguous matches
fail closed and ask you to set `marketplaceName` or `marketplacePath`.

## Bundled macOS marketplace

Recent Codex desktop builds bundle Computer Use here:

```text
/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use
```

When `computerUse.autoInstall` is true and no marketplace containing
`computer-use` is registered, OpenClaw tries to add the standard bundled
marketplace root automatically:

```text
/Applications/Codex.app/Contents/Resources/plugins/openai-bundled
```

You can also register it explicitly from a shell with Codex:

```bash
codex plugin marketplace add /Applications/Codex.app/Contents/Resources/plugins/openai-bundled
```

If you use a nonstandard Codex app path, set `computerUse.marketplacePath` to a
local marketplace file path or run `/codex computer-use install --source
<marketplace-source>` once.

## Remote catalog limit

Codex app-server can list and read remote-only catalog entries, but it does not
currently support remote `plugin/install`. That means `marketplaceName` can
select a remote-only marketplace for status checks, but installs and re-enables
still need a local marketplace via `marketplaceSource` or `marketplacePath`.

If status says the plugin is available in a remote Codex marketplace but remote
install is unsupported, run install with a local source or path:

```text
/codex computer-use install --source <marketplace-source>
/codex computer-use install --marketplace-path <path>
```

## Configuration reference

| Field                           | Default        | Meaning                                                                        |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `enabled`                       | inferred       | Require Computer Use. Defaults to true when another Computer Use field is set. |
| `autoInstall`                   | false          | Install or re-enable from already discovered marketplaces at turn start.       |
| `marketplaceDiscoveryTimeoutMs` | 60000          | How long install waits for Codex app-server marketplace discovery.             |
| `marketplaceSource`             | unset          | Source string passed to Codex app-server `marketplace/add`.                    |
| `marketplacePath`               | unset          | Local Codex marketplace file path containing the plugin.                       |
| `marketplaceName`               | unset          | Registered Codex marketplace name to select.                                   |
| `pluginName`                    | `computer-use` | Codex marketplace plugin name.                                                 |
| `mcpServerName`                 | `computer-use` | MCP server name exposed by the installed plugin.                               |

Turn-start auto-install intentionally refuses configured `marketplaceSource`
values. Adding a new source is an explicit setup operation, so use
`/codex computer-use install --source <marketplace-source>` once, then let
`autoInstall` handle future re-enables from discovered local marketplaces.
Turn-start auto-install can use a configured `marketplacePath`, because that is
already a local path on the host.

## What OpenClaw checks

OpenClaw reports a stable setup reason internally and formats the user-facing
status for chat:

| Reason                       | Meaning                                                | Next step                                     |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `disabled`                   | `computerUse.enabled` resolved to false.               | Set `enabled` or another Computer Use field.  |
| `marketplace_missing`        | No matching marketplace was available.                 | Configure source, path, or marketplace name.  |
| `plugin_not_installed`       | Marketplace exists, but the plugin is not installed.   | Run install or enable `autoInstall`.          |
| `plugin_disabled`            | Plugin is installed but disabled in Codex config.      | Run install to re-enable it.                  |
| `remote_install_unsupported` | Selected marketplace is remote-only.                   | Use `marketplaceSource` or `marketplacePath`. |
| `mcp_missing`                | Plugin is enabled, but the MCP server is unavailable.  | Check Codex Computer Use and OS permissions.  |
| `ready`                      | Plugin and MCP tools are available.                    | Start the Codex-mode turn.                    |
| `check_failed`               | A Codex app-server request failed during status check. | Check app-server connectivity and logs.       |
| `auto_install_blocked`       | Turn-start setup would need to add a new source.       | Run explicit install first.                   |

The chat output includes the plugin state, MCP server state, marketplace, tools
when available, and the specific message for the failing setup step.

## macOS permissions

Computer Use is macOS-specific. The Codex-owned MCP server may need local OS
permissions before it can inspect or control apps. If OpenClaw says Computer Use
is installed but the MCP server is unavailable, verify the Codex-side Computer
Use setup first:

- Codex app-server is running on the same host where desktop control should
  happen.
- The Computer Use plugin is enabled in Codex config.
- The `computer-use` MCP server appears in Codex app-server MCP status.
- macOS has granted the required permissions for the desktop-control app.
- The current host session can access the desktop being controlled.

OpenClaw intentionally fails closed when `computerUse.enabled` is true. A
Codex-mode turn should not silently proceed without the native desktop tools
that the config required.

## Troubleshooting

**Status says not installed.** Run `/codex computer-use install`. If the
marketplace is not discovered, pass `--source` or `--marketplace-path`.

**Status says installed but disabled.** Run `/codex computer-use install` again.
Codex app-server install writes the plugin config back to enabled.

**Status says remote install is unsupported.** Use a local marketplace source or
path. Remote-only catalog entries can be inspected but not installed through the
current app-server API.

**Status says the MCP server is unavailable.** Re-run install once so MCP
servers reload. If it remains unavailable, fix the Codex Computer Use app,
Codex app-server MCP status, or macOS permissions.

**Status or a probe times out on `computer-use.list_apps`.** The plugin and MCP
server are present, but the local Computer Use bridge did not answer. Quit or
restart Codex Computer Use, relaunch Codex Desktop if needed, then retry in a
fresh OpenClaw session.

**A Computer Use tool says `Native hook relay unavailable`.** The Codex-native
tool hook could not reach an active OpenClaw relay through the local bridge or
Gateway fallback. Start a fresh OpenClaw session with `/new` or `/reset`. If it
keeps happening, restart the gateway so old app-server threads and hook
registrations are dropped, then retry.

**Turn-start auto-install refuses a source.** This is intentional. Add the
source with explicit `/codex computer-use install --source <marketplace-source>`
first, then future turn-start auto-install can use the discovered local
marketplace.

## Related

- [Codex harness](/plugins/codex-harness)
- [Peekaboo bridge](/platforms/mac/peekaboo)
- [iOS app](/platforms/ios)
