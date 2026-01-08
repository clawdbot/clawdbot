---
summary: "Bundled bun gateway: packaging, launchd, signing, and bytecode"
read_when:
  - Packaging Clawdbot.app
  - Debugging the bundled gateway binary
  - Changing bun build flags or codesigning
---

# Bundled bun Gateway (macOS)

Goal: ship **Clawdbot.app** with a self-contained relay binary that can run both the CLI and the Gateway daemon. No global `npm install -g clawdbot`, no system Node requirement.

## What gets bundled

App bundle layout:

- `Clawdbot.app/Contents/Resources/Relay/clawdbot`
  - bun `--compile` relay executable built from [`dist/macos/relay.js`](https://github.com/clawdbot/clawdbot/blob/main/dist/macos/relay.js)
  - Supports:
    - `clawdbot …` (CLI)
    - `clawdbot gateway …` (LaunchAgent daemon)
- `Clawdbot.app/Contents/Resources/Relay/package.json`
  - tiny “p runtime compatibility” file (see below)
- `Clawdbot.app/Contents/Resources/Relay/theme/`
  - p TUI theme payload (optional, but strongly recommended)

Why the sidecar files matter:
- The embedded p runtime detects “bun binary mode” and then looks for `package.json` + `theme/` **next to `process.execPath`** (i.e. next to `clawdbot`).
- So even if bun can embed assets, the runtime expects filesystem paths. Keep the sidecar files.

## Build pipeline

Packaging script:
- [`scripts/package-mac-app.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/package-mac-app.sh)

It builds:
- TS: `pnpm exec tsc`
- Swift app + helper: `swift build …`
- bun relay: `bun build dist/macos/relay.js --compile --bytecode …`

Important bundler flags:
- `--compile`: produces a standalone executable
- `--bytecode`: reduces startup time / parsing overhead (works here)
- externals:
  - `-e electron`
  - Reason: avoid bundling Electron stubs in the relay binary

Version injection:
- `--define "__CLAWDBOT_VERSION__=\"<pkg version>\""`
- [`src/version.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/version.ts) also supports `__CLAWDBOT_VERSION__` (and `CLAWDBOT_BUNDLED_VERSION`) so `--version` doesn’t depend on reading `package.json` at runtime.

## Launchd (Gateway as LaunchAgent)

Label:
- `com.clawdbot.gateway`

Plist location (per-user):
- `~/Library/LaunchAgents/com.clawdbot.gateway.plist`

Manager:
- [`apps/macos/Sources/Clawdbot/GatewayLaunchAgentManager.swift`](https://github.com/clawdbot/clawdbot/blob/main/apps/macos/Sources/Clawdbot/GatewayLaunchAgentManager.swift)

Behavior:
- “Clawdbot Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).

Logging:
- launchd stdout/err: `/tmp/clawdbot/clawdbot-gateway.log`

Default LaunchAgent env:
- `CLAWDBOT_IMAGE_BACKEND=sips` (avoid sharp native addon under bun)

## Codesigning (hardened runtime + bun)

Symptom (when mis-signed):
- `Ran out of executable memory …` on launch

Fix:
- The bun executable needs JIT-ish permissions under hardened runtime.
- [`scripts/codesign-mac-app.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/codesign-mac-app.sh) signs `Relay/clawdbot` with:
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`

## Image processing under bun

Problem:
- bun can’t load some native Node addons like `sharp` (and we don’t want to ship native addon trees for the gateway).

Solution:
- Central helper [`src/media/image-ops.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/media/image-ops.ts)
  - Prefers `/usr/bin/sips` on macOS (esp. when running under bun)
  - Falls back to `sharp` when available (Node/dev)
- Used by:
  - [`src/web/media.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/web/media.ts) (optimize inbound/outbound images)
  - [`src/browser/screenshot.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/browser/screenshot.ts)
  - [`src/agents/pi-tools.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/agents/pi-tools.ts) (image sanitization)

## Browser control server

The Gateway starts the browser control server (loopback only) from [`src/gateway/server.ts`](https://github.com/clawdbot/clawdbot/blob/main/src/gateway/server.ts).
It’s started from the relay daemon process, so the relay binary includes Playwright deps.

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

## Repo hygiene

Bun may leave dotfiles like `*.bun-build` in the repo root or subfolders.
- These are ignored via `.gitignore` (`*.bun-build`).

## DMG styling (human installer)

[`scripts/create-dmg.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/create-dmg.sh) styles the DMG via Finder AppleScript.

Rules of thumb:
- Use a **72dpi** background image that matches the Finder window size in points.
- Preferred asset: `assets/dmg-background-small.png` (**500×320**).
- Default icon positions: app `{125,160}`, Applications `{375,160}`.
