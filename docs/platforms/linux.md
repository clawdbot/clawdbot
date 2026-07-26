---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Enabling camera, location, or notifications on a Linux node host
  - Planning platform coverage or contributions
  - Debugging Linux OOM kills or exit 137 on a VPS or container
title: "Linux app"
---

The Gateway is fully supported on Linux and requires Node. Bun can still be used
as a dependency installer or package-script runner, but it cannot run OpenClaw
because it does not provide `node:sqlite`.

## Desktop companion

The OpenClaw Linux companion is a Tauri desktop app for a local Gateway. It:

- installs the OpenClaw CLI and managed Node runtime when they are missing; release builds install the stable channel automatically, while development builds ask for the channel first
- attaches to a healthy Gateway before attempting service changes
- delegates install, start, stop, and restart operations to the CLI-managed systemd user service
- discovers nearby Bonjour Gateways and opens each Control UI in a route-scoped window, so several
  Gateway dashboards can stay connected and be used simultaneously
- opens the Gateway-served Control UI with its resolved authentication URL
- opens the Control UI in onboarding mode after its first-run install, which
  offers to import detected Claude Code, Codex, or Hermes memories into the
  agent workspace (the same import stays available later under
  Settings → Import Memory)
- renders agent-driven Canvas and bundled A2UI content for a colocated CLI node host
- remains available from the system tray when its window is closed

Stable releases built from `main` ship `.deb` and AppImage bundles as assets on the
[GitHub release](https://github.com/openclaw/openclaw/releases) for the tag,
named `OpenClaw-<version>-amd64.deb` and `OpenClaw-<version>-amd64.AppImage`,
with a `SHA256SUMS.linux-app.txt` checksum file next to them. Download the
`.deb` and install it with `sudo apt install ./OpenClaw-<version>-amd64.deb`,
or mark the AppImage executable and run it directly. The AppImage runtime
needs FUSE 2 (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04+);
without it, run the AppImage with `APPIMAGE_EXTRACT_AND_RUN=1`.

You can also build the same bundles from a source checkout:

```bash
cd apps/linux/src-tauri
pnpm dlx @tauri-apps/cli@2.11.4 build --bundles deb,appimage
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

### Canvas

Linux Canvas uses two cooperating processes. `openclaw node run` remains the single Gateway node connection; the bundled `linux-canvas` plugin forwards `canvas.*` calls to the running desktop app over a user-only Unix socket. The app owns one on-demand WebView window, including the bundled A2UI renderer and action bridge back to the agent.

The plugin is enabled by default. It advertises Canvas only when the desktop socket exists at `$XDG_RUNTIME_DIR/openclaw-canvas.sock`, or `/tmp/openclaw-canvas-$UID.sock` when `XDG_RUNTIME_DIR` is unavailable. Disable it with `plugins.entries.linux-canvas.enabled: false`. On a headless Linux server without the desktop app, Canvas is not advertised.

Linux v1 uses one Canvas window. HTTP and HTTPS pages are renderable, but A2UI actions are accepted only from the bundled renderer.

## CLI and SSH alternative

The CLI remains the simplest option for a headless server, a VPS, or a remote Gateway:

1. Install Node 24.15+ (recommended), Node 22.22.3+ (LTS), or Node 25.9+.
2. `npm i -g openclaw@latest`
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
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
RestartPreventExitStatus=78
TimeoutStopSec=30
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
`/bin/sh` shim that raises the child's own `oom_score_adj` to `1000`, then
`exec`s the real command. This is unprivileged: a process may always raise
its own OOM score.

Covered child process surfaces:

- Supervisor-managed command children
- PTY shell children
- MCP stdio server children
- OpenClaw-launched browser/Chrome processes (via the plugin SDK process runtime)

The wrapper is Linux-only and skipped when `/bin/sh` is unavailable, or when
the child env sets `OPENCLAW_CHILD_OOM_SCORE_ADJ` to `0`, `false`, `no`, or
`off`.

Verify a child process:

```bash
cat /proc/<child-pid>/oom_score_adj
```

Expected value for covered children is `1000`; the Gateway process itself
keeps its normal score (usually `0`).

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
- [Raspberry Pi](/platforms/raspberry-pi)
- [Gateway runbook](/gateway)
- [Gateway configuration](/gateway/configuration)
