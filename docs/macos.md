---
summary: "Spec for the Clawdbot macOS companion menu bar app (gateway + node broker)"
read_when:
  - Implementing macOS app features
  - Changing gateway lifecycle or node bridging on macOS
---
# Clawdbot macOS Companion (menu bar + gateway broker)

Author: steipete · Status: draft spec · Date: 2025-12-20

## Purpose
- Single macOS menu-bar app named **Clawdbot** that:
  - Shows native notifications for Clawdbot/clawdbot events.
  - Owns TCC prompts (Notifications, Accessibility, Screen Recording, Automation/AppleScript, Microphone, Speech Recognition).
  - Runs (or connects to) the **Gateway** and exposes itself as a **node** so agents can reach macOS‑only features.
  - Hosts **PeekabooBridge** for UI automation (consumed by `peekaboo`; see `docs/mac/peekaboo.md`).
  - Installs a single CLI (`clawdbot`) by symlinking the bundled binary.

## High-level design
- SwiftPM package in `apps/macos/` (macOS 15+, Swift 6).
- Targets:
  - `ClawdbotIPC` (shared Codable types + helpers for app‑internal actions).
  - `Clawdbot` (LSUIElement MenuBarExtra app; hosts Gateway + node bridge + PeekabooBridgeHost).
- Bundle ID: `com.clawdbot.mac`.
- Bundled runtime binaries live under `Contents/Resources/Relay/`:
  - `clawdbot` (bun‑compiled relay: CLI + gateway-daemon)
- The app symlinks `clawdbot` into `/usr/local/bin` and `/opt/homebrew/bin`.

## Gateway + node bridge
- The mac app runs the Gateway in **local** mode (unless configured remote).
- The gateway port is configurable via `gateway.port` or `CLAWDBOT_GATEWAY_PORT` (default 18789). The mac app reads that value for launchd, probes, and remote SSH tunnels.
- The mac app connects to the bridge as a **node** and advertises capabilities/commands.
- Agent‑facing actions are exposed via `node.invoke` (no local control socket).
- The mac app watches `~/.clawdbot/clawdbot.json` and switches modes live when `gateway.mode` or `gateway.remote.url` changes.
- If `gateway.mode` is unset but `gateway.remote.url` is set, the mac app treats it as remote mode.
- Changing connection mode in the mac app writes `gateway.mode` (and `gateway.remote.url` in remote mode) back to the config file.

### Node commands (mac)
- Canvas: `canvas.present|navigate|eval|snapshot|a2ui.*`
- Camera: `camera.snap|camera.clip`
- Screen: `screen.record`
- System: `system.run` (shell) and `system.notify`

### Permission advertising
- Nodes include a `permissions` map in hello/pairing.
- The Gateway surfaces it via `node.list` / `node.describe` so agents can decide what to run.

## CLI (`clawdbot`)
- The **only** CLI is `clawdbot` (TS/bun). There is no `clawdbot-mac` helper.
- For mac‑specific actions, the CLI uses `node.invoke`:
  - `clawdbot canvas present|navigate|eval|snapshot|a2ui push|a2ui reset`
  - `clawdbot nodes run --node <id> -- <command...>`
  - `clawdbot nodes notify --node <id> --title ...`

## Onboarding
- Install CLI (symlink) → Permissions checklist → Test notification → Done.
- Remote mode skips local gateway/CLI steps.
- Selecting Local auto-enables the bundled Gateway via launchd (unless “Attach only” debug mode is enabled).

## Deep links (URL scheme)

Clawdbot (the macOS app) registers a URL scheme for triggering local actions from anywhere (browser, Shortcuts, CLI, etc.).

Scheme:
- `clawdbot://…`

### `clawdbot://agent`

Triggers a Gateway `agent` request (same machinery as WebChat/agent runs).

Example:

```bash
open 'clawdbot://agent?message=Hello%20from%20deep%20link'
```

Query parameters:
- `message` (required): the agent prompt (URL-encoded).
- `sessionKey` (optional): explicit session key to use.
- `thinking` (optional): thinking hint (e.g. `low`; omit for default).
- `deliver` (optional): `true|false` (default: false).
- `to` / `channel` (optional): forwarded to the Gateway `agent` method (only meaningful with `deliver=true`).
- `timeoutSeconds` (optional): timeout hint forwarded to the Gateway.
- `key` (optional): unattended mode key (see below).

Safety/guardrails:
- Always enabled.
- Without a `key` query param, the app will prompt for confirmation before invoking the agent.
- With `key=<value>`, Clawdbot runs without prompting (intended for personal automations).
  - The current key is shown in Debug Settings and stored locally in UserDefaults.

Notes:
- In local mode, Clawdbot will start the local Gateway if needed before issuing the request.
- In remote mode, Clawdbot will use the configured remote tunnel/endpoint.

## Build & dev workflow (native)
- `cd apps/macos && swift build` (debug) / `swift build -c release`.
- Run app for dev: `swift run Clawdbot` (or Xcode scheme).
- Package app + CLI: `scripts/package-mac-app.sh` (builds bun CLI + gateway).
- Tests: add Swift Testing suites under `apps/macos/Tests`.

## Open questions / decisions
- Should `system.run` support streaming stdout/stderr or keep buffered responses only?
- Should we allow node‑side permission prompts, or always require explicit app UI action?
