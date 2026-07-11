---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

OpenClaw.app does not bundle Node/Bun or the Gateway runtime. The macOS app
expects an **external** `openclaw` CLI install, does not spawn the Gateway as
a child process, and manages a per-user launchd service to keep the Gateway
running (or attaches to an already-running local Gateway).

## Automatic setup

On a fresh Mac, choose **This Mac** during onboarding. The app runs its
signed, bundled installer script before the Gateway wizard: it installs a
user-space Node runtime and the matching `openclaw` CLI under `~/.openclaw`,
then installs and starts the per-user launchd service. This path needs no
Terminal, Homebrew, or administrator access.

The app bundles the installer script only, not the Node or Gateway payload;
setup needs an internet connection to download the runtime and matching
OpenClaw package.

## Manual recovery

Node 24 is recommended for a manual install; Node 22.19+ also works. Install
`openclaw` globally:

```bash
npm install -g openclaw@<version>
```

Use **Retry setup** after a failed automatic setup. If that still fails,
install the CLI manually with the command above, then choose **Check again**
in onboarding.

## Launchd (Gateway as LaunchAgent)

Label: `ai.openclaw.gateway` (default profile), or `ai.openclaw.<profile>`
for a named profile.

Plist location (per-user): `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
(or `ai.openclaw.<profile>.plist`).

The macOS app owns LaunchAgent install/update for the default profile in
Local mode. The CLI can also install it directly: `openclaw gateway install`
(named profiles are selected via the `OPENCLAW_PROFILE` env var).

Behavior:

- "OpenClaw Active" enables/disables the LaunchAgent.
- Quitting the app does **not** stop the Gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use
  `gateway-<profile>.log`)
- launchd stderr: suppressed
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.openclaw.gateway` / `ai.openclaw.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gatewaynode-launchagents).

## Version compatibility

The macOS app checks the Gateway version against its own version. Onboarding
automatically runs managed setup when an existing CLI is missing or
incompatible. Use **Retry setup** to repeat installation, or **Check again**
after repairing an external CLI.

## State directory on macOS

Keep OpenClaw state on a local, non-synced disk. Avoid iCloud Drive and other
cloud-synced folders; sync latency and file locks can affect sessions,
credentials, and Gateway state.

Set `OPENCLAW_STATE_DIR` to a local path only when you need an override.
`openclaw doctor` warns about common cloud-synced state paths and recommends
moving back to local storage. See
[environment variables](/help/environment#path-related-env-vars) and
[Doctor](/gateway/doctor).

## Debug app connectivity

Use the macOS debug CLI from a source checkout to exercise the same Gateway
WebSocket handshake and discovery logic the app uses:

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

`connect` accepts `--url`, `--token`, `--timeout`, `--probe`, and `--json`
(plus client-identity overrides; run with `--help` for the full list).
`discover` accepts `--timeout`, `--json`, and `--include-local`. Compare
discovery output with `openclaw gateway discover --json` when you need to
separate CLI discovery from app-side connection issues.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Then:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
