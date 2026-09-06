# OpenClaw for Linux

The Linux companion is a Tauri v2 desktop shell for local and remote OpenClaw Gateways. It discovers nearby Gateways over Bonjour, installs the CLI when local setup needs it, delegates local Gateway service management to `openclaw gateway`, opens the selected Gateway's Control UI, and stays available in the system tray.

The tray's **Stop Gateway** and **Restart Gateway** actions request graceful shutdown. Running work can delay completion; **Start Gateway** brings a stopped local Gateway back online.

Published AMD64 AppImages are built on Ubuntu 22.04 and require glibc 2.35 or
newer plus a `libstdc++` that provides `GLIBCXX_3.4.30`. Ubuntu 22.04 and
Debian 12 meet that ABI floor. RHEL 9 and Rocky Linux 9 ship glibc 2.34, so
they cannot run the published AppImage. Extraction does not bypass this
requirement.

## Linux prerequisites

Debian and Ubuntu development packages:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf xdg-utils
```

Install a current stable Rust toolchain with `rustup`.

## Media codecs

The companion uses GStreamer plugins for audio and video playback.
WebM/VP9, Opus, Vorbis, and WAV normally work through `plugins-good`.
H.264/MP4, AAC, and MP3 require the `libav` and/or `plugins-bad` packages.
The `.deb` uses the host's plugins and declares all three packages as
dependencies. The AppImage bundles the GStreamer media framework and the
plugins required for the formats above. For a source build or when rebuilding
either Linux bundle, install the packages and inspection tool explicitly:

```bash
sudo apt update && sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-tools patchelf xdg-utils
```

The packaging script stages only that media capability set before Tauri invokes
linuxdeploy. This prevents optional host plugins from adding unrelated system
libraries to the AppImage dependency closure.

The packaging flow provisions Tauri's five AppImage tools into a clean,
digest-pinned cache. After Tauri builds the AppImage, the finalizer re-verifies
that cache, removes bundled Wayland client libraries from the retained AppDir,
and rebuilds the artifact. WebKitGTK and Mesa then use one compatible host
stack.

## Develop and build

The companion frontend is static HTML, CSS, and JavaScript. Install repository dependencies once
before building:

```bash
pnpm install
cd apps/linux/src-tauri
cargo run
cargo build
```

The app uses `OPENCLAW_DESKTOP_CLI` when set. Otherwise it checks `~/.openclaw/bin/openclaw`, then `openclaw` on `PATH`.

Desktop notifications use each platform's system notification service. macOS 13+ uses Apple's User Notifications framework; Windows uses native system toasts and Linux uses the desktop notification service through `notify-rust`. On macOS, test notifications from a signed `.app` bundle: a direct `cargo run` stays unbundled, so the app disables notifications instead of initializing Apple's framework with no bundle identity.

## First-run setup

The welcome screen explains what OpenClaw can do and asks where your assistant
should live:

- **On this computer** installs the CLI and managed Node runtime when needed,
  then starts the Gateway as a systemd user service. Release builds install the
  stable channel automatically; development builds ask for a release channel
  and preselect Development.
- **On another computer** connects to an existing Gateway without installing or
  starting a local Gateway service. Select a nearby discovered Gateway, enter a
  Gateway URL directly, or choose **SSH tunnel** and enter `user@gateway-host`.
  Expand **Gateway authentication** to provide either the Gateway token or its
  password when the remote host requires one.

Public direct connections must use HTTPS or secure WebSockets. Plain HTTP or
WebSockets are appropriate only for loopback, trusted private networks, or a
Tailnet. If the Gateway configuration specifies a TLS certificate fingerprint,
choose **SSH tunnel**: the embedded browser cannot enforce certificate pins, so
the app safely refuses direct connections instead of exposing your credentials.
Saved remote credentials support literal values and environment- or
file-backed secret references; exec and shared-store references must be
resolved on their owning Gateway host. SSH connections use your existing
OpenSSH configuration and host-key verification; keep the remote Gateway bound
to loopback when possible. See the
[remote access guide](https://docs.openclaw.ai/gateway/remote) for Gateway
authentication and network requirements.

After connecting, Model Setup checks existing credentials and verifies a real
model response before continuing. If no existing credentials work, choose a
provider and either sign in or enter an API key. The selected Gateway owns the
provider credentials and model configuration. A working existing model opens
the normal dashboard; newly configured AI access continues into guided
onboarding. In-progress model setup and guided onboarding survive Gateway
restarts. If the app closes while model activation is in progress, reopening it
resumes the same Gateway, agent, and model without activating the provider
twice.

For OpenAI, **ChatGPT Login** uses a ChatGPT or Codex subscription, while
**OpenAI API Key** uses API billing. When the Gateway runs on another host and
its browser callback is not reachable, choose **ChatGPT Device Pairing** from
the additional sign-in options.

## Updates

The companion checks the latest GitHub release shortly after launch and from **Check for Updates** in the tray menu. AppImage installs download and verify the signed update in place, then wait for **Restart to update**. Package-managed installs such as `.deb` stay owned by the system package manager and link to the release download page instead of replacing installed files. The macOS and Windows test builds use a separate opt-in desktop-test update channel; macOS self-updates like the AppImage build, while Windows downloads the update first and runs its installer only after **Restart to update**.

## Quick Chat widgets

Quick Chat advertises the Gateway `inline-widgets` capability and renders hosted `show_widget` results in isolated child WebViews. The parent Quick Chat WebView is the only one granted Tauri commands; widget WebViews match no capability and therefore have no IPC access. Quick Chat accepts only assistant-message widget previews under the capability-scoped `/__openclaw__/canvas/documents/` route, blocks navigation away from the original document, uses nonpersistent WebViews, and keeps stable widget instances while switching among multiple previews. Connections that require a custom Gateway TLS leaf pin remain text-only because the platform WebView cannot bind that pin. Like the other native clients, Quick Chat does not expose the Control UI `sendPrompt` bridge.

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
rsvg-convert -w 36 -h 36 tray-template.svg -o tray-template.png
```

macOS gets its own tray asset, `icons/tray-template.svg`. AppKit template images
are drawn from the alpha channel alone, so a colored or edge-to-edge opaque icon
arrives in the menu bar as a featureless blob; the template source is a
silhouette with the eyes knocked back out of it. Its geometry mirrors the native
macOS app's `CritterIconRenderer` at rest so both clients wear the same face, and
the 36px render is the 2× backing store for the 18pt slot `tray-icon` scales
menu bar images into. Non-Apple platforms keep the full-color `32x32.png`.

## Packaging

Build a `.deb` and AppImage locally (the same command CI runs):

```bash
plugins=$(mktemp -d)
cache=$(mktemp -d)
trap 'rm -rf "$plugins" "$cache"' EXIT
export XDG_CACHE_HOME="$cache"
apps/linux/scripts/stage-appimage-gstreamer.sh "$plugins"
apps/linux/scripts/tauri-appimage-tools.sh prepare
apps/linux/scripts/tauri-appimage-tools.sh verify pre-build
export LDAI_RUNTIME_FILE="$cache/tauri/.appimage-runtime-x86_64"
(
  cd apps/linux/src-tauri
  GSTREAMER_PLUGINS_DIR="$plugins" \
    pnpm dlx @tauri-apps/cli@2.11.4 build --bundles deb,appimage \
      --config '{"bundle":{"createUpdaterArtifacts":false,"useLocalToolsDir":false}}'
)
apps/linux/scripts/finalize-appimage.sh \
  apps/linux/src-tauri/target/release/bundle/appimage
```

Bundles land in `target/release/bundle/{deb,appimage}/`. The `Linux App` CI
workflow uploads them as the `openclaw-linux-companion` artifact on pull
requests touching `apps/linux/**` and on manual dispatch.

## Releases

Manually dispatch `Linux App Release Request` from `main`. Provide the existing
stable release tag in `tag`; prerelease tags are rejected because their semver
suffix breaks Debian upgrade ordering. Enable the optional
`desktop-test-bundles` input only when unsigned macOS and Windows test bundles
are needed.

A successful request automatically triggers `Linux App Release`. It builds from
the validated release tag SHA and attaches the bundles to that tag's GitHub
release with a `SHA256SUMS.linux-app.txt` checksum file. The tag commit must be
reachable from `main` or its matching `release/YYYY.M.PATCH` branch; numeric
correction tags use the base version's release branch.
