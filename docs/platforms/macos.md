---
summary: "Clawdbot macOS companion app (menu bar + gateway broker)"
read_when:
  - Implementing macOS app features
  - Changing gateway lifecycle or node bridging on macOS
---
# Clawdbot macOS Companion (menu bar + gateway broker)

The macOS app is the **menu‑bar companion** for Clawdbot. It owns permissions,
manages the Gateway locally, and exposes macOS capabilities to the agent as a
node.

## What it does

- Shows native notifications and status in the menu bar.
- Owns TCC prompts (Notifications, Accessibility, Screen Recording, Microphone,
  Speech Recognition, Automation/AppleScript).
- Runs or connects to the Gateway (local or remote).
- Exposes macOS‑only tools (Canvas, Camera, Screen Recording, `system.run`).
- Optionally hosts **PeekabooBridge** for UI automation.
- Installs the global CLI (`clawdbot`) via npm/pnpm on request (bun not recommended for the Gateway runtime).

## Local vs remote mode

- **Local** (default): the app ensures a local Gateway is running via launchd.
- **Remote**: the app connects to a Gateway over SSH/Tailscale and never starts
  a local process.
- **Attach‑only** (debug): the app connects to an already‑running local Gateway
  and never spawns its own.

## Launchd control

The app manages a per‑user LaunchAgent labeled `com.clawdbot.gateway`
(or `com.clawdbot.<profile>` when using `--profile`/`CLAWDBOT_PROFILE`).

```bash
launchctl kickstart -k gui/$UID/com.clawdbot.gateway
launchctl bootout gui/$UID/com.clawdbot.gateway
```

Replace the label with `com.clawdbot.<profile>` when running a named profile.

If the LaunchAgent isn’t installed, enable it from the app or run
`clawdbot daemon install`.

## Node capabilities (mac)

The macOS app presents itself as a node. Common commands:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

The node reports a `permissions` map so agents can decide what’s allowed.

## Exec approvals (system.run)

`system.run` is controlled by **Exec approvals** in the macOS app (Settings → Exec approvals).
Security + ask + allowlist are stored locally on the Mac in:

```
~/.clawdbot/exec-approvals.json
```

Example:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        { "pattern": "/opt/homebrew/bin/rg" }
      ]
    }
  }
}
```

Notes:
- `allowlist` entries are JSON-encoded argv arrays.
- Choosing “Always Allow” in the prompt adds that command to the allowlist.
- `system.run` environment overrides are filtered (drops `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) and then merged with the app’s environment.

## Deep links

The app registers the `clawdbot://` URL scheme for local actions.

### `clawdbot://agent`

Triggers a Gateway `agent` request.

```bash
open 'clawdbot://agent?message=Hello%20from%20deep%20link'
```

Query parameters:
- `message` (required)
- `sessionKey` (optional)
- `thinking` (optional)
- `deliver` / `to` / `channel` (optional)
- `timeoutSeconds` (optional)
- `key` (optional unattended mode key)

Safety:
- Without `key`, the app prompts for confirmation.
- With a valid `key`, the run is unattended (intended for personal automations).

## Onboarding flow (typical)

1) Install and launch **Clawdbot.app**.
2) Complete the permissions checklist (TCC prompts).
3) Ensure **Local** mode is active and the Gateway is running.
4) Install the CLI if you want terminal access.

## Build & dev workflow (native)

- `cd apps/macos && swift build`
- `swift run Clawdbot` (or Xcode)
- Package app: `scripts/package-mac-app.sh`

## Debug gateway discovery (macOS CLI)

Use the debug CLI to exercise the same Bonjour + wide‑area discovery code that the
macOS app uses, without launching the app.

```bash
cd apps/macos
swift run clawdbot-mac-discovery --timeout 3000 --json
```

Options:
- `--include-local`: include gateways that would be filtered as “local”
- `--timeout <ms>`: overall discovery window (default `2000`)
- `--json`: structured output for diffing

Tip: compare against `pnpm clawdbot gateway discover --json` to see whether the
macOS app’s discovery pipeline (NWBrowser + tailnet DNS‑SD fallback) differs from
the Node CLI’s `dns-sd` based discovery.

## Remote connection plumbing (SSH tunnels)

When the macOS app runs in **Remote** mode, it opens SSH tunnels so local UI
components can talk to a remote Gateway as if it were on localhost. There are
two independent tunnels:

### Control tunnel (Gateway control/WebSocket port)
- **Purpose:** health checks, status, Web Chat, config, and other control-plane calls.
- **Local port:** the Gateway port (default `18789`), always stable.
- **Remote port:** the same Gateway port on the remote host.
- **Behavior:** no random local port; the app reuses an existing healthy tunnel
  or restarts it if needed.
- **SSH shape:** `ssh -N -L <local>:127.0.0.1:<remote>` with BatchMode +
  ExitOnForwardFailure + keepalive options.

### Node bridge tunnel (macOS node mode)
- **Purpose:** connect the macOS node to the Gateway **Bridge** protocol (TCP JSONL).
- **Remote port:** `gatewayPort + 1` (default `18790`), derived from the Gateway port.
- **Local port preference:** `CLAWDBOT_BRIDGE_PORT` or the default `18790`.
- **Behavior:** prefer the default bridge port for consistency; fall back to a
  random local port if the preferred one is busy. The node then connects to the
  resolved local port.

For setup steps, see [macOS remote access](/platforms/mac/remote). For protocol
details, see [Bridge protocol](/gateway/bridge-protocol).

## Related docs

- [Gateway runbook](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS permissions](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
