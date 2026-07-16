# OpenClaw for Linux

The Linux companion is a Tauri v2 desktop shell for OpenClaw Gateways. It discovers nearby Gateways over Bonjour, installs the CLI when needed, delegates local Gateway service management to `openclaw gateway`, opens the selected Gateway's Control UI, and stays available in the system tray.

## Linux prerequisites

Debian and Ubuntu development packages:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Install a current stable Rust toolchain with `rustup`.

## Develop and build

The frontend is static HTML, CSS, and JavaScript. It has no package install or build step.

```bash
cd apps/linux/src-tauri
cargo run
cargo build
```

The app uses `OPENCLAW_DESKTOP_CLI` when set. Otherwise it checks `~/.openclaw/bin/openclaw`, then `openclaw` on `PATH`.

## Canvas bridge

The running app gives the headless `openclaw node run` host a single Canvas WebView. The bundled `linux-canvas` plugin advertises `canvas.*` only while the app socket exists. The app listens at `$XDG_RUNTIME_DIR/openclaw-canvas.sock` (or `/tmp/openclaw-canvas-$UID.sock`) with mode `0600`; a headless Linux node without the app does not advertise Canvas.

The plugin-generated A2UI renderer in `extensions/canvas/src/host/a2ui/` remains the source of truth. The app embeds its committed, synced OpenClawKit mirror from `apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/CanvasA2UI/`. Run `node scripts/sync-native-a2ui.mjs --check` from the repository root after changing those assets.

## Installer resource

`tauri.conf.json` bundles the repository's canonical `scripts/install-cli.sh` directly as `install-cli.sh`. The app never keeps a forked copy. Stable, beta, and dev installs select `latest`, `beta`, and a managed Git `main` checkout respectively, always under `~/.openclaw`.

## Icons

The icon sources of truth live next to the PNGs: `icons/icon.svg` (transparent
claw mark, used by the tray) and `icons/icon-tile.svg` (claw mark on the dark
brand tile, used for the app and package icons). Regenerate the committed PNGs
with librsvg:

```bash
cd apps/linux/src-tauri/icons
rsvg-convert -w 32 --keep-aspect-ratio icon.svg -o 32x32.png
magick 32x32.png -background none -gravity center -extent 32x32 PNG32:32x32.png
rsvg-convert -w 128 -h 128 icon-tile.svg -o 128x128.png
rsvg-convert -w 256 -h 256 icon-tile.svg -o 128x128@2x.png
rsvg-convert -w 512 -h 512 icon-tile.svg -o icon.png
magick icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

## Packaging

Build a `.deb` and AppImage locally (the same command CI runs):

```bash
cd apps/linux/src-tauri
pnpm dlx @tauri-apps/cli@2.11.4 build --bundles deb,appimage
```

Bundles land in `target/release/bundle/{deb,appimage}/`. The `Linux App` CI
workflow uploads them as the `openclaw-linux-companion` artifact on pull
requests touching `apps/linux/**` and on manual dispatch.

## Releases

The `Linux App Release` workflow (manual dispatch, release operators) builds
the bundles from an existing stable release tag (prerelease tags are
rejected: their semver suffix breaks Debian upgrade ordering) and attaches them to that tag's
GitHub release with a `SHA256SUMS.linux-app.txt` checksum file. It refuses
tags whose commit is not reachable from `main`: Linux bundles ship for
main-based releases only.
