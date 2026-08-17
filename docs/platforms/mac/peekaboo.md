---
summary: "PeekabooBridge integration for macOS UI automation"
read_when:
  - Hosting PeekabooBridge in OpenClaw.app
  - Integrating Peekaboo via Swift Package Manager
  - Changing PeekabooBridge protocol/paths
  - Deciding between PeekabooBridge, Codex Computer Use, and cua-driver MCP
title: "Peekaboo bridge"
---

OpenClaw can host **PeekabooBridge** as a local, permission-aware UI automation broker (`PeekabooBridgeHostCoordinator`, backed by the `steipete/Peekaboo` Swift package). This lets the `peekaboo` CLI drive UI automation while reusing the macOS app's TCC permissions.

## What this is (and is not)

- **Host**: OpenClaw.app can act as a PeekabooBridge host.
- **Client**: the `peekaboo` CLI (there is no separate `openclaw ui ...` surface).
- **UI**: visual overlays stay in Peekaboo.app; OpenClaw is a thin broker host.

## Relationship to other desktop-control paths

OpenClaw has four desktop-control paths that intentionally stay separate:

- **PeekabooBridge host**: OpenClaw.app hosts the local PeekabooBridge socket. The `peekaboo` CLI is the client and uses OpenClaw.app's macOS permissions for screenshots, clicks, menus, dialogs, Dock actions, and window management.
- **Agent-driven computer use (`computer.act`)**: the gateway agent's built-in `computer` tool captures screenshots via `screen.snapshot` and drives the pointer and keyboard through the dangerous `computer.act` node command. A macOS node fulfills `computer.act` in-process using the embedded Peekaboo automation services this bridge exposes plus narrow CoreGraphics primitives, without going through the PeekabooBridge socket or the `peekaboo` CLI. See [Computer use](/nodes/computer-use).
- **Codex Computer Use**: the bundled `codex` plugin checks and can install Codex's `computer-use` MCP plugin (`extensions/codex/src/app-server/computer-use.ts`), then lets Codex own native desktop-control tool calls during Codex-mode turns. OpenClaw does not proxy those actions through PeekabooBridge.
- **Direct `cua-driver` MCP**: OpenClaw can register TryCua's upstream `cua-driver mcp` server as a normal MCP server, giving agents the CUA driver's own schemas and pid/window/element-index workflow without routing through the Codex marketplace or the PeekabooBridge socket.

Use Peekaboo for the broad macOS automation surface via OpenClaw.app's permission-aware bridge host. Use agent-driven computer use when the gateway agent should see and control the desktop through a uniform `computer.act` node command that any vision model can drive. Use Codex Computer Use when a Codex-mode agent should rely on Codex's native plugin. Use direct `cua-driver mcp` to expose the CUA driver to any OpenClaw-managed runtime as a normal MCP server.

## Enable the bridge

In the macOS app: **Settings -> Enable Peekaboo Bridge**. The toggle requires **Allow Computer Control** to be on, since both grant local UI automation; with Computer Control off the toggle is disabled and the host does not run. To drive Peekaboo without Computer Control, run Peekaboo's own Mac app as the host instead.

When enabled (and Computer Control is on), OpenClaw starts a local UNIX socket server at `~/Library/Application Support/OpenClaw/<socket-name>`. If disabled, the host stops and `peekaboo` falls back to other available hosts. The coordinator also maintains legacy socket symlinks (`clawdbot`, `clawdis`, `moltbot` under Application Support) pointing at the current socket for older `peekaboo` installs.

For a one-off unattended run, `--attach-only --background-only` suppresses automatic windows and GUI-owned Keychain
loading. The persistent elevation host is a managed-deployment path for OpenClaw Foundation release operators. Its
`package` command requires the Foundation signing identity and notarization credentials; OpenClaw does not currently
publish a general-download elevation archive. Install only a certified, source-addressed archive supplied by an
authorized release operator:

```bash
cd /path/to/elevation-artifact-set
shasum -a 256 -c "OpenClaw-<full-source-sha>-stable.zip.sha256"
shasum -a 256 -c "OpenClaw-<full-source-sha>-stable-installer.sh.sha256"
./OpenClaw-<full-source-sha>-stable-installer.sh install \
  --archive "OpenClaw-<full-source-sha>-stable.zip"
./OpenClaw-<full-source-sha>-stable-installer.sh status
```

Transfer the complete artifact set: archive, receipt, portable installer, and both checksum files. The target Mac does
not need an OpenClaw source checkout. Verify both checksums before running the installer.

`--elevation-host` is implied by the installed job. It keeps the Bridge, control channel, Mac node, Gateway
connectivity, and termination handling active while disabling automatic windows, updater startup, Dock promotion,
pairing and exec-approval presenters, Quick Chat hotkeys, voice and cookie services, and GUI-owned Keychain reads.
Missing Screen Recording, Accessibility, or Event Synthesizing is reported by `status`; the host never opens System
Settings to grant it. Installation succeeds once the launchd-owned process is Bridge-ready even if those grants are
still incomplete; `status` returns a degraded-readiness result until all required grants are present. The installer
uses the separate `ai.openclaw.mac.elevation-host` job and refuses to race or rewrite ordinary **Launch at login**
(`ai.openclaw.mac`).

The elevation archive is Foundation-signed, notarized, stapled, named by the full OpenClaw source commit, and contains
exactly `OpenClaw.app`. Its receipt binds the archive and installer names and digests, OpenClaw and Peekaboo source
revisions, signer, CDHash, architectures, entitlement digests, and Apple notarization submission ID. No AppleScript or
Apple Events entitlement is part of this workflow.

## Client discovery order

Peekaboo clients typically try hosts in this order:

1. Peekaboo.app (full UX)
2. Claude.app (if installed)
3. OpenClaw.app (thin broker)

Use `peekaboo bridge status --verbose` to see which host is active and which socket path is in use. Override with:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Security and permissions

- The bridge validates **caller code signatures**. The production OpenClaw host accepts only the exact Peekaboo CLI
  bundle (`boo.peekaboo.peekaboo`) signed by Peekaboo's canonical current/legacy release signer set (`FWJYW4S8P8`
  and `Y5PE65HELJ`); sharing the app's UID or using another client signed by the app's development team is not
  sufficient.
- Prefer the signed bridge/app identity over a generic `node` runtime for Accessibility. Granting Accessibility to `node` lets any package launched by that Node executable inherit GUI automation access; see [macOS permissions](/platforms/mac/permissions#accessibility-grants-for-node-and-cli-runtimes).
- Requests time out after 10 seconds (`requestTimeoutSec: 10`).
- If required permissions are missing, the bridge returns a clear error message rather than launching System Settings.

## Snapshot behavior (automation)

Snapshots are stored in memory with a 10-minute validity window and a cap of 50 snapshots (`InMemorySnapshotManager`); artifacts are not deleted on cleanup. If you need longer retention, re-capture from the client.

## Troubleshooting

- If `peekaboo` reports "bridge client is not authorized", ensure the client is properly signed or run the host with `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` in **debug** mode only.
- If no hosts are found, open one of the host apps (Peekaboo.app or OpenClaw.app) and confirm permissions are granted.

## Related

- [macOS app](/platforms/macos)
- [macOS permissions](/platforms/mac/permissions)
