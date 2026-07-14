# OpenClaw for Linux

The Linux companion is a Tauri v2 desktop shell for a local OpenClaw Gateway. It installs the CLI when needed, delegates Gateway service management to `openclaw gateway`, opens the Gateway-served Control UI with its resolved auth URL, and stays available in the system tray.

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
