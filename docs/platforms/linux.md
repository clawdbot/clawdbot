---
summary: "Linux support + companion app status"
read_when:
  - Looking for Linux companion app status
  - Planning platform coverage or contributions
  - Debugging Linux OOM kills or exit 137 on a VPS or container
title: "Linux app"
---

The Gateway is fully supported on Linux and requires Node. Bun can still be used
as a dependency installer or package-script runner, but it cannot run OpenClaw
because it does not provide `node:sqlite`.

## Desktop companion

The OpenClaw Linux companion is a Tauri desktop app for a local Gateway. It:

- installs the OpenClaw CLI and managed Node runtime when they are missing
- attaches to a healthy Gateway before attempting service changes
- delegates install, start, stop, and restart operations to the CLI-managed systemd user service
- opens the Gateway-served Control UI with its resolved authentication URL
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
