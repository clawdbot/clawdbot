---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

OpenClaw.app bundles a private Node runtime and matching OpenClaw package for
its app-owned `node worker` helper. Rebuilding or replacing the app replaces
that helper too, including rebuilds with the same public version. The helper
runs from the signed bundle, so moving the app or removing its build checkout
does not change which worker it uses.

The **Gateway remains external**. The app uses an external `openclaw` CLI to
manage a per-user launchd service, or attaches to an already-running Gateway.
It does not start the Gateway inside its private worker runtime. Packaging the
worker never installs, updates, or restarts a Gateway service.

The private worker validates core and node configuration through a read-only
bootstrap, without Gateway-wide Doctor preflight or channel-schema validation.
Node plugins still validate their own settings before publishing commands, and
the node runtime owns its MCP clients. Node startup retains the Doctor-owned
device-auth, device-identity, and exec-approval migrations; this is not a promise
that all worker startup is read-only. Public `node run`, Gateway, and Doctor
retain their existing startup policies.

When the native app creates identity, device-auth, or approval tables before
the worker starts, node startup completes that recognized version-zero database
through the canonical initializer before plugins read their state. Existing
native rows are preserved. This does not migrate an already-versioned shared
Gateway database or adopt unknown or occupied bootstrap state.

## Automatic setup

On a fresh Mac, choose **This Mac** during onboarding. The app runs its
signed, bundled installer script before the Gateway wizard: it installs a
user-space Node runtime and the matching `openclaw` CLI under `~/.openclaw`,
then installs and starts the per-user launchd service. This path needs no
Terminal, Homebrew, or administrator access.

Gateway setup still needs an internet connection to download its separate
runtime and matching OpenClaw package. The bundled installer owns that setup;
the private worker is not a replacement for a CLI or Gateway installation.

Remote connections and attachment to an independently managed local Gateway
skip this installation. Attach-only mode never prompts for a CLI to run the
app's node. Pausing preserves who manages the Gateway, even when stopping an
app-managed service removes its LaunchAgent record. If an independent endpoint
is no longer available on reattachment, local setup becomes available again.
An unreadable service ownership record blocks automatic installation instead
of being treated as a missing service; check the LaunchAgent and retry.

## Manual recovery

For a manual install, use Node 26 (recommended) or another supported release:
Node 22.22.3+, Node 24.15+, or Node 25.9+. Install `openclaw` globally:

The command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm install -g openclaw@<version> --allow-scripts=openclaw
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

Use the CLI for lifecycle checks and recovery:

```bash
openclaw gateway status --deep
openclaw gateway restart
```

Launchd provides auto-start at login, crash restarts, and one predictable log
location without tying the Gateway lifetime to the app process.

### Attach-only development

When another process already owns the local Gateway, run the development app
without installing or changing its LaunchAgent:

```bash
scripts/restart-mac.sh --attach-only
```

Launching the app directly with `--attach-only` or `--no-launchd` has the same
effect. The override persists in `~/.openclaw/disable-launchagent`; remove that
file to restore app-managed launchd behavior.

Logging:

- launchd stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use
  `gateway-<profile>.log`)
- launchd stderr: suppressed
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.openclaw.gateway` / `ai.openclaw.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents).

## Version compatibility

The private worker must match the app's build provenance, not merely its
version number. A missing or incompatible worker payload produces a visible
worker error; rebuild or reinstall the app. Changing CLI channels or updating
a global CLI does not repair this private payload. Unbundled Swift development
builds can use the checkout's freshness-aware source runner instead.

For an app-owned local Gateway, the macOS app checks the external CLI against
its install policy. Onboarding runs managed setup when that CLI is missing or
incompatible. An attached Gateway uses connection and health checks instead of
local CLI installation diagnostics. Use **Retry setup** after a failed managed
installation, or open **Connection… → Connection** from the menu bar and choose
**Recheck** after repairing it. The Connection window remains available when
the Dashboard cannot reach the Gateway.

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
openclaw gateway call health --port 18999 --timeout 3000
```

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
