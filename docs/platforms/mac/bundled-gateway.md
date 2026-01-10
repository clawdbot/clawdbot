---
summary: "Bundled gateway runtime: packaging, launchd, signing, and bundling"
read_when:
  - Packaging Clawdbot.app
  - Debugging the bundled gateway binary
  - Changing relay bundling flags or codesigning
---

# Bundled Gateway (macOS)

Goal: ship **Clawdbot.app** with a self-contained relay that can run the CLI and
Gateway daemon. No global `npm install -g clawdbot`, no system Node requirement.

## What gets bundled

App bundle layout:

- `Clawdbot.app/Contents/Resources/Relay/node`
  - Node runtime binary (downloaded during packaging, stripped for size)
- `Clawdbot.app/Contents/Resources/Relay/dist/`
  - Compiled CLI/gateway payload from `pnpm exec tsc`
- `Clawdbot.app/Contents/Resources/Relay/node_modules/`
  - Production dependencies staged via `pnpm deploy --prod --no-optional --legacy`
- `Clawdbot.app/Contents/Resources/Relay/clawdbot`
  - Wrapper script that execs the bundled Node + dist entrypoint
- `Clawdbot.app/Contents/Resources/Relay/package.json`
  - tiny “Pi runtime compatibility” file (see below, includes `"type": "module"`)
- `Clawdbot.app/Contents/Resources/Relay/skills/`
  - Bundled skills payload (required for Pi tools)
- `Clawdbot.app/Contents/Resources/Relay/theme/`
  - Pi TUI theme payload (optional, but strongly recommended)
- `Clawdbot.app/Contents/Resources/Relay/a2ui/`
  - A2UI host assets (served by the gateway)
- `Clawdbot.app/Contents/Resources/Relay/control-ui/`
  - Control UI build output (served by the gateway)

Why the sidecar files matter:
- The embedded Pi runtime detects “bundled relay mode” and then looks for
  `package.json` + `theme/` **next to `process.execPath`** (i.e. next to
  `node`). Keep the sidecar files.

## Build pipeline

Packaging script:
- [`scripts/package-mac-app.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/package-mac-app.sh)

It builds:
- TS: `pnpm exec tsc`
- Swift app + helper: `swift build …`
- Relay payload: `pnpm deploy --prod --no-optional --legacy` + copy `dist/`
- Node runtime: downloads the latest Node release (override via `NODE_VERSION`)

Important knobs:
- `NODE_VERSION=22.12.0` → pin a specific Node version
- `NODE_DIST_MIRROR=…` → mirror for downloads (default: nodejs.org)
- `STRIP_NODE=0` → keep symbols (default strips to reduce size)
- `BUNDLED_RUNTIME=bun` → switch the relay build back to Bun (`bun --compile`)

Version injection:
- The relay wrapper exports `CLAWDBOT_BUNDLED_VERSION` so `--version` works
  without reading `package.json` at runtime.

## Launchd (Gateway as LaunchAgent)

Label:
- `com.clawdbot.gateway`

Plist location (per-user):
- `~/Library/LaunchAgents/com.clawdbot.gateway.plist`

Manager:
- The macOS app owns LaunchAgent install/update for the bundled gateway.

Behavior:
- “Clawdbot Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- CLI install (`clawdbot daemon install`) writes the same LaunchAgent; `--force` rewrites it.

Logging:
- launchd stdout/err: `/tmp/clawdbot/clawdbot-gateway.log`

Default LaunchAgent env:
- `CLAWDBOT_IMAGE_BACKEND=sips` (avoid sharp native addon inside the bundle)

## Codesigning (hardened runtime + Node)

Node uses JIT. The bundled runtime is signed with:
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

This is applied by `scripts/codesign-mac-app.sh`.

## Image processing

To avoid shipping native `sharp` addons inside the bundle, the gateway defaults
to `/usr/bin/sips` for image ops when run from the app (via launchd env + wrapper).

## Tests / smoke checks

From a packaged app (local build):

```bash
dist/Clawdbot.app/Contents/Resources/Relay/clawdbot --version

CLAWDBOT_SKIP_PROVIDERS=1 \
CLAWDBOT_SKIP_CANVAS_HOST=1 \
dist/Clawdbot.app/Contents/Resources/Relay/clawdbot gateway --port 18999 --bind loopback
```

Then, in another shell:

```bash
pnpm -s clawdbot gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
