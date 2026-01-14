---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging Clawdbot.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
---

# Gateway on macOS (external launchd)

Clawdbot.app no longer bundles Node/Bun or the Gateway runtime. The macOS app
expects an **external** `clawdbot` CLI install and manages a per‑user launchd
service to keep the Gateway running.

## Install the CLI (required for local mode)

You need Node 22+ on the Mac, then install `clawdbot` globally:

```bash
npm install -g clawdbot@<version>
```

The macOS app’s **Install CLI** button runs the same flow via npm/pnpm (bun not recommended for Gateway runtime).

## Launchd (Gateway as LaunchAgent)

Label:
- `com.clawdbot.gateway` (or `com.clawdbot.<profile>`)

Plist location (per‑user):
- `~/Library/LaunchAgents/com.clawdbot.gateway.plist`

Manager:
- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `clawdbot daemon install`.

Behavior:
- “Clawdbot Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).

Logging:
- launchd stdout/err: `/tmp/clawdbot/clawdbot-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## Smoke check

```bash
clawdbot --version

CLAWDBOT_SKIP_CHANNELS=1 \
CLAWDBOT_SKIP_CANVAS_HOST=1 \
clawdbot gateway --port 18999 --bind loopback
```

Then:

```bash
clawdbot gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
