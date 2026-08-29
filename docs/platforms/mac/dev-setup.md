---
summary: "Setup guide for developers working on the OpenClaw macOS app"
read_when:
  - Setting up the macOS development environment
title: "macOS dev setup"
---

# macOS developer setup

Build and run the OpenClaw macOS application from source.

## Prerequisites

- **Xcode 26.4+** (Swift 6.3 toolchain), on the latest macOS available in
  Software Update.
- **Node.js 24.15+ & pnpm** for the gateway, CLI, and packaging scripts. Node
  22.22.3+ also works.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Build and package the app

```bash
./scripts/package-mac-app.sh
```

Outputs `dist/OpenClaw.app`. Packaging requires a real signing identity by
default; ad-hoc signing is an explicit opt-in and does not preserve TCC grants.
See [macOS signing](/platforms/mac/signing).

Set `OPENCLAW_SKIP_MLX_TTS=1` to package a dev/proof build without the local
MLX voice helper. This skips the `openclaw-mlx-tts` binary and its large
mlx-swift Metal shader stack, which some beta Xcode toolchains cannot compile.
The resulting app has no on-device MLX voice; it is rejected for `release`
builds, which must ship the helper.

For dev run modes, signing flags, and Team ID troubleshooting, see
[apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md).
Fast dev loop from repo root: `scripts/restart-mac.sh` (add `--no-sign` for
ad-hoc signing; TCC permissions do not stick with `--no-sign`).

<Note>
Ad-hoc signed apps may trigger security prompts. If the app crashes
immediately with "Abort trap 6", see [Troubleshooting](#troubleshooting).
</Note>

## 3. Install the CLI and Gateway

The packaged app embeds the canonical `scripts/install-cli.sh` installer. On a
fresh profile, choose **This Mac** during onboarding; the app installs the
matching user-space CLI and runtime before starting the Gateway wizard.

For manual development recovery, install the matching CLI yourself:

The npm command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm install -g openclaw@<version> --allow-scripts=openclaw
```

`pnpm add -g --allow-build=openclaw openclaw@<version>` and
`bun add -g --trust openclaw@<version>` also work. Bun's `--trust` allows the
OpenClaw lifecycle scripts for that install. Node remains the recommended
runtime for the Gateway itself.

## Run native tests safely

Run the full macOS app test suite in a disposable macOS VM or CI worker with
no operator credentials, config, or running Gateway. AppKit tests can show
windows, and WebKit starts helper processes. A temporary `HOME`, `TMPDIR`, or
named app profile alone is not a sandbox: fixed preferences domains and
Keychain access can still reach macOS services outside those directories.

On an operator desktop, run only an audited subset inside an OS sandbox that
blocks operator files, preferences and Keychain services, unwanted network
access, and desktop/helper processes. A Swift test filter is not itself an
isolation boundary. If that boundary cannot be established, use the disposable
macOS environment instead.

Tests should own their resources: unique defaults suites with cleanup,
nonpersistent WebKit data stores, ephemeral loopback fixture endpoints, and
temporary files rooted in `FileManager.temporaryDirectory`. Unix-domain socket
fixtures require a short test-owned `TMPDIR`; an overlong path fails rather than
silently writing outside that directory. The cooperative `TestIsolation` helper
serializes and restores participating tests' environment
and defaults mutations; it does not isolate the process from the host.

## Troubleshooting

### Build fails: toolchain or SDK mismatch

The macOS app build expects the latest macOS SDK and the Swift 6.3 toolchain
(Xcode 26.4+).

```bash
xcodebuild -version
xcrun swift --version
```

If versions don't match, update macOS/Xcode and re-run the build.

### Build fails: MLX voice helper Metal shaders

On a beta-only Xcode toolchain (for example Xcode 27 with the macOS 27 SDK),
only the `openclaw-mlx-tts` helper may fail while the main app builds fine. The
mlx-swift Metal compilation errors non-deterministically (a different `.metal`
file each run, `Could not read serialized diagnostics file` then a nonzero
`metal` exit), because the beta `metal` compiler and its separately downloaded
Metal Toolchain are still unstable. This is an upstream toolchain issue, not an
OpenClaw one.

If you do not need on-device MLX voice, skip the helper:

```bash
OPENCLAW_SKIP_MLX_TTS=1 ./scripts/package-mac-app.sh
```

Otherwise, install the Metal Toolchain
(`xcodebuild -downloadComponent MetalToolchain`) and build from a stable Xcode
release.

### App crashes on permission grant

If the app crashes when you try to allow **Speech Recognition** or
**Microphone** access, it may be a corrupted TCC cache or signature mismatch.

1. Reset TCC permissions for the debug bundle id:

   ```bash
   tccutil reset All ai.openclaw.mac.debug
   ```

2. If that fails, temporarily change `BUNDLE_ID` in
   [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh)
   to force a clean slate from macOS.

### Gateway "Starting..." indefinitely

Check whether a zombie process holds the port:

```bash
openclaw gateway status
openclaw gateway stop

# If you're not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

If a manual run holds the port, stop it (Ctrl+C), or kill the PID found above
as a last resort.

## Related

- [macOS app](/platforms/macos)
- [Install overview](/install)
