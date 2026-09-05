---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Enabling camera, location, or notifications on a Linux node host
  - Planning platform coverage or contributions
  - Debugging Linux OOM kills or exit 137 on a VPS or container
title: "Linux app"
---

The Gateway is fully supported on Linux. Node is the primary, default, and
recommended runtime; Bun 1.4+ builds with WAL-reset-safe `node:sqlite` can run
OpenClaw as an explicit opt-in. Use `pnpm` rather than Bun for dependency
installation.

## Desktop companion

The OpenClaw Linux companion is a Tauri desktop app for local and remote
Gateways. It:

- walks new users through choosing a local Gateway, a discovered remote Gateway,
  a manually entered Gateway URL, or an SSH tunnel
- installs the OpenClaw CLI and Node in a private managed runtime when local
  setup needs them, rather than requiring a global CLI install; release builds
  install the stable channel automatically, while development builds ask for
  the channel first
- attaches to a healthy Gateway before attempting service changes
- delegates install, start, stop, and restart operations to the CLI-managed systemd user service
- discovers nearby Bonjour Gateways and opens each Control UI in a route-scoped window, so several
  Gateway dashboards can stay connected and be used simultaneously
- opens the Gateway-served Control UI with its resolved authentication URL
- opens Model Setup for an unconfigured local or remote Gateway, automatically
  tests available AI credentials, and verifies an existing model before
  opening the dashboard
- continues into guided onboarding after connecting a new model; onboarding can
  import detected Claude Code, Codex, or Hermes memories into the agent workspace
  (the same import stays available later under Settings → Import Memory)
- remains available from the system tray when its window is closed

### First-run setup

Choose **Get started** on the welcome screen, then choose where your assistant
should live:

- **On this computer** installs any missing local prerequisites and starts the
  Gateway as a systemd user service.
- **On another computer** connects to an existing Gateway. Select a discovered
  Gateway, enter its address under **Gateway URL**, or choose **SSH tunnel**
  and enter an SSH target such as `user@gateway-host`. The Gateway port defaults
  to `18789`.

If the remote Gateway requires authentication, expand **Gateway authentication**
and enter its token or password. Use one credential type, matching the remote
Gateway's configuration. Remote setup does not install or start a local Gateway
service; the remote host owns its model, provider credentials, and agent state.

Use HTTPS or `wss://` for public direct connections. Plain HTTP or `ws://`
should be limited to loopback, trusted private networks, and Tailnet hosts.
When the saved configuration includes `gateway.remote.tlsFingerprint`, select
**SSH tunnel** instead of a direct connection. The embedded browser cannot
enforce a certificate pin, so the app rejects direct connections before loading
the remote dashboard or exposing its credentials. Saved remote token and
password values can use environment- or file-backed SecretRefs; exec and
shared-store references must be resolved on their owning Gateway host.
SSH uses your existing OpenSSH authentication and host-key verification. See
[Remote access](/gateway/remote) for secure Gateway configuration.

After the connection succeeds, Model Setup checks for existing AI credentials,
offers provider sign-in or API-key entry when needed, and requires a successful
model response before opening the agent. An already configured Gateway opens
its normal dashboard after verification; newly configured access continues into
guided onboarding.

Model Setup can resume an activation across a Gateway restart or app reopen
while its temporary recovery record is valid. Recovery stays bound to the same
Gateway, agent, and authentication. When the known activation target still
matches the selected model, OpenClaw verifies that exact model before continuing
guided onboarding rather than activating the provider again. For an unresolved
result, use **Verify & use selected model** to explicitly verify and adopt a
displayed model, or wait for the setup attempt's bounded window to end before
choosing **Check again**.
Recovery is not guaranteed after that record expires, browser storage becomes
unavailable or is cleared, or the Gateway, agent, or authentication changes.

Ollama automatic discovery uses eligible models already loaded in memory, not
all models installed on disk. To use an idle installed model, choose **Choose
connection** on its Ollama card, then **Local only**. See [Ollama](/providers/ollama).

For OpenAI, choose **ChatGPT Login** to use a ChatGPT or Codex subscription, or
**OpenAI API Key** for API billing. Browser sign-in completes on the Gateway
host. If that host is remote or its localhost callback cannot be reached,
choose **ChatGPT Device Pairing** from the additional sign-in options instead;
device pairing works without a localhost callback. See
[OpenAI](/providers/openai) and [OAuth](/concepts/oauth).

When the desktop app starts with a supported provider API key in its environment,
the Gateway service keeps that dedicated inference credential in an owner-only
environment file. Provider admin keys, GitHub tokens, and unrelated environment
variables are not copied into the service.

### Host sleep

On systems with systemd-logind, the companion prepares a suspension lease for
its local Gateway before the host sleeps. After wake, it reconnects and resumes
the Gateway; remote Gateway routes are left untouched. If logind or the system
bus is unavailable, the sleep hook disables itself and the app continues
normally.

Realtime voice Talk inside the companion's embedded WebView is not validated:
the shell does not grant microphone capture to the WebKitGTK WebView, so
`getUserMedia` is expected to fail there. Until that lands, open the Gateway's
Control UI in a regular browser for [Talk mode](/nodes/talk).

Stable releases built from `main` or their matching `release/YYYY.M.PATCH` branch
ship `.deb` and AppImage bundles as assets on the
[GitHub release](https://github.com/openclaw/openclaw/releases) for the tag,
named `OpenClaw-<version>-amd64.deb` and `OpenClaw-<version>-amd64.AppImage`,
with a `SHA256SUMS.linux-app.txt` checksum file next to them. Download the
`.deb` and install it with `sudo apt install ./OpenClaw-<version>-amd64.deb`,
or mark the AppImage executable and run it directly. The AppImage runtime
needs FUSE 2 (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04+);
without it, run the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1`.

Published AMD64 AppImages are built on Ubuntu 22.04 and require glibc 2.35 or
newer plus a `libstdc++` that provides `GLIBCXX_3.4.30`. Ubuntu 22.04 and
Debian 12 meet that ABI floor. RHEL 9 and Rocky Linux 9 ship glibc 2.34, so
they cannot run the published AppImage. Extracting the AppImage does not bypass
this requirement.

### Media codecs

The companion uses GStreamer plugins for audio and video playback.
WebM/VP9, Opus, Vorbis, and WAV normally work through `plugins-good`.
H.264/MP4, AAC, and MP3 require the `libav` and/or `plugins-bad` packages.
The `.deb` uses the host's plugins and declares all three packages as
dependencies. The AppImage bundles the GStreamer media framework and the
plugins required for those formats. For a source build or when rebuilding
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

You can also build the same bundles from a source checkout:

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

The `Linux App` CI workflow uploads the same bundles as the
`openclaw-linux-companion` artifact for pull requests touching the app and for
manual runs. See `apps/linux/README.md` in the repository for Linux build
dependencies and development commands.

### Quick Chat

Open Quick Chat with `Ctrl+Shift+Space` or the **Quick Chat** tray item. The agent
chip shows the configured avatar, emoji, or monogram; select it to switch agents.
Messages use the selected agent's main session and honor global session scope.
The native Rust client owns a persistent Ed25519 device identity. It uses the
CLI handoff's shared token or password only to bootstrap pairing, then stores and
prefers the Gateway-issued device token on later connections. The identity and
device token live in the app config directory in a mode `0600` file; Quick
Chat's WebView receives neither credentials nor the WebSocket.

When the native connection is unavailable, Quick Chat shows **Gateway
unreachable — retrying** and disables send until reconnection. A remote device
that has reached the pairing phase shows **Approve this device in the dashboard
(Nodes)** instead, with a short device ID when the Gateway provides one. A
Gateway that requires a missing shared credential shows **Gateway requires a
credential — open the dashboard on the gateway host**; no pairing request is
waiting for approval in that state. Server-provided remediation guidance
replaces these fallback notices when it is more specific.
For TLS Gateways, the CLI hands the app the Gateway certificate's SHA-256
fingerprint; the native client pins that certificate and reports **Gateway TLS
trust failed — check the certificate fingerprint** separately from downtime.
Gateways whose shared secret is configured through a SecretRef omit it from the
CLI handoff. Existing paired installs keep working through their stored device
token, but a fresh install cannot create a pending pairing request under shared-secret
authentication without that bootstrap credential.
Setup-code and `bootstrapToken` redemption need dedicated product UI and remain
a follow-up; Quick Chat does not attempt either flow.

On X11, use the gear in Quick Chat to record or reset a custom shortcut. The
**Quick Chat shortcut** tray toggle enables or disables it without disabling the
plain **Quick Chat** tray item. Global shortcuts are not available on Wayland, so
the shortcut settings are hidden and the tray item remains the entry point.
After an accepted send, Quick Chat stays open and streams the selected agent's
plain-text reply below the composer. Press `Esc` to dismiss the bar and its reply;
`Ctrl+Enter` still opens the dashboard.

## CLI and SSH alternative

The CLI remains the simplest option for a headless server or VPS. Use a manual
SSH tunnel when connecting without the Linux desktop companion:

1. Install Node 26 (recommended), or another supported release: Node 22.22.3+, Node 24.15+, or Node 25.9+.
2. On npm 12 or npm 11.16+, run `npm i -g openclaw@latest --allow-scripts=openclaw`. On npm 11.15 and earlier, omit `--allow-scripts=openclaw`.
3. `openclaw onboard --install-daemon`
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` and authenticate with the configured shared
   secret (token by default; password if `gateway.auth.mode` is `"password"`).

Full server guide: [Linux Server](/vps). Step-by-step VPS example:
[exe.dev](/install/exe-dev).

## Node capabilities

The bundled Linux Node plugin gives the CLI `openclaw node` service device capabilities without requiring the desktop app. Commands are advertised to the Gateway only when their capability is enabled and the required local tool exists.

| Capability                              | Default | Requirement                                                           |
| --------------------------------------- | ------- | --------------------------------------------------------------------- |
| Desktop notifications (`system.notify`) | On      | `notify-send` from libnotify and a desktop notification session       |
| Camera photos and clips (`camera.*`)    | Off     | FFmpeg, V4L2 camera access, and PulseAudio or PipeWire for clip audio |
| Location (`location.get`)               | Off     | GeoClue2 and its `where-am-i` demo                                    |

Configure the plugin in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "linux-node": {
        config: {
          notify: { enabled: true },
          camera: { enabled: true },
          location: { enabled: true },
        },
      },
    },
  },
}
```

Restart the node service after changing these settings. Availability is determined once per process and the node advertisement is rebuilt on restart.

The Gateway approves the node's command and capability surface separately from device pairing. On first start, or after enabling more capabilities, approve the pending surface:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

A node can be connected and device-paired while its effective `caps` and `commands` remain empty until this approval completes.

Camera devices must be readable by the service user, commonly through the `video` group. Camera clips use the default PulseAudio or PipeWire source when `includeAudio` is true; microphone audio exists only as that clip track, not as a standalone command. Location requires the node-service user to be permitted by the host's GeoClue policy.

`camera.snap` and `camera.clip` also require explicit Gateway arming through `gateway.nodes.commands.allow`. See [Camera capture](/nodes/camera) and [Location command](/nodes/location-command) for payloads, limits, and errors.

## Retired Linux Canvas

The bundled Linux Canvas bridge and its desktop Canvas window have been removed.
For inline widgets in the Control UI, use [`show_widget`](/tools/show-widget).
The separate [macOS widget panel](/platforms/mac/canvas) requires a connected
Mac and is render-only. These widget surfaces do not restore the former Linux
Canvas bridge or its A2UI push commands.

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional: [Bun package workflow](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway service (systemd)

Install with one of:

```bash
openclaw onboard --install-daemon
openclaw gateway install
openclaw configure   # select "Gateway service" when prompted
```

Repair or migrate an existing install:

```bash
openclaw doctor
```

`openclaw gateway install` renders a systemd **user** unit by default. Full
service guidance, including the **system**-level unit variant for shared or
always-on hosts, lives in the [Gateway runbook](/gateway#supervision-and-service-lifecycle).

Write a unit by hand only for a custom setup. Minimal user-unit example
(`~/.config/systemd/user/openclaw-gateway[-<profile>].service`):

```ini
[Unit]
Description=OpenClaw Gateway (profile: <profile>)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
RestartPreventExitStatus=78
TimeoutStopSec=330
TimeoutStartSec=30
SuccessExitStatus=0 143
OOMPolicy=continue
KillMode=control-group

[Install]
WantedBy=default.target
```

Hand-written units do not inherit the adaptive heap sizing that `openclaw gateway install` writes for managed Gateway services. Prefer the managed installer, or set an explicit heap limit in the custom supervisor after accounting for native-memory headroom.

Enable it:

```bash
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

## Memory pressure and OOM kills

On Linux, the kernel picks an OOM victim when a host, VM, or container cgroup
runs out of memory. The Gateway is a poor victim because it owns long-lived
sessions and channel connections, so OpenClaw biases transient child
processes to be killed first when possible.

For eligible Linux child spawns, OpenClaw wraps the command in a short
`/bin/sh` shim that attempts to raise the child's own `oom_score_adj` to
`1000`, then `exec`s the real command. This is unprivileged: a process may
always raise its own OOM score.

Covered child process surfaces:

- Supervisor-managed command children
- PTY shell children
- MCP stdio server children
- Managed local model and embedding service children
- OpenClaw-launched browser/Chrome processes (via the plugin SDK process runtime)

The wrapper is Linux-only and skipped when `/bin/sh` is unavailable, or when
the child env sets `OPENCLAW_CHILD_OOM_SCORE_ADJ` to `0`, `false`, `no`, or
`off`.
Use this opt-out only for controlled diagnosis: it removes child-first OOM
protection and makes the Gateway more likely to be selected as the victim under
real memory pressure.

Managed local model and embedding services fall back to direct spawn when their
effective environment defines `SHELLOPTS`, `BASHOPTS`, a `BASH_FUNC_*` key, or
a reserved `OC_INTERNAL_OOM_EXEC_{BASH_ENV,ENV,CDPATH,PS4}` carrier. Exact
environment fidelity and shell startup safety take precedence in these cases,
so OpenClaw does not attempt to change `oom_score_adj`; use the verification
below to check the child's effective value.

Verify a child process:

```bash
cat /proc/<child-pid>/oom_score_adj
```

When the write succeeds, the expected value for covered children is `1000`.
If `/proc` is unavailable or unwritable, the child still runs without the OOM
bias. The Gateway process itself keeps its normal score (usually `0`).

The systemd unit's `OOMPolicy=continue` keeps the Gateway service alive when
a transient child is selected by the OOM killer instead of marking the whole
unit failed and restarting all channels; the failed child/session reports its
own error.

This does not replace normal memory tuning. If a VPS or container repeatedly
kills children, raise the memory limit, reduce concurrency, or add stronger
resource controls (systemd `MemoryMax=`, container memory limits).

## Related

- [Install overview](/install)
- [Linux server](/vps)
- [ChromeOS (Crostini)](/platforms/chromeos)
- [Raspberry Pi](/install/raspberry-pi)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
