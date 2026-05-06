---
summary: "Host OpenClaw on a Raspberry Pi for always-on self-hosting"
read_when:
  - Setting up OpenClaw on a Raspberry Pi
  - Running OpenClaw on ARM devices
  - Building a cheap always-on personal AI
title: "Raspberry Pi"
---

Run a persistent, always-on OpenClaw Gateway on a Raspberry Pi. Since the Pi is just the gateway (models run in the cloud via API), even a modest Pi handles the workload well — typical hardware cost is **$35–80 one-time**, no monthly fees.

## Hardware compatibility

| Pi model    | RAM    | Works? | Notes                               |
| ----------- | ------ | ------ | ----------------------------------- |
| Pi 5        | 4/8 GB | Best   | Fastest, recommended.               |
| Pi 4        | 4 GB   | Good   | Sweet spot for most users.          |
| Pi 4        | 2 GB   | OK     | Add swap.                           |
| Pi 4        | 1 GB   | Tight  | Possible with swap, minimal config. |
| Pi 3B+      | 1 GB   | Slow   | Works but sluggish.                 |
| Pi Zero 2 W | 512 MB | No     | Not recommended.                    |

**Minimum:** 1 GB RAM, 1 core, 500 MB free disk, 64-bit OS.
**Recommended:** 2 GB+ RAM, 16 GB+ SD card (or USB SSD), Ethernet.

## Prerequisites

- Raspberry Pi 4 or 5 with 2 GB+ RAM (4 GB recommended)
- MicroSD card (16 GB+) or USB SSD (better performance)
- Official Pi power supply
- Network connection (Ethernet or WiFi)
- 64-bit Raspberry Pi OS (required -- do not use 32-bit)
- About 30 minutes

## Setup

<Steps>
  <Step title="Flash the OS">
    Use **Raspberry Pi OS Lite (64-bit)** -- no desktop needed for a headless server.

    1. Download [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
    2. Choose OS: **Raspberry Pi OS Lite (64-bit)**.
    3. In the settings dialog, pre-configure:
       - Hostname: `gateway-host`
       - Enable SSH
       - Set username and password
       - Configure WiFi (if not using Ethernet)
    4. Flash to your SD card or USB drive, insert it, and boot the Pi.

  </Step>

  <Step title="Connect via SSH">
    ```bash
    ssh user@gateway-host
    ```
  </Step>

  <Step title="Update the system">
    ```bash
    sudo apt update && sudo apt upgrade -y
    sudo apt install -y git curl build-essential

    # Set timezone (important for cron and reminders)
    sudo timedatectl set-timezone America/Chicago
    ```

  </Step>

  <Step title="Install Node.js 24">
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version
    ```
  </Step>

  <Step title="Add swap (important for 2 GB or less)">
    ```bash
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

    # Reduce swappiness for low-RAM devices
    echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    ```

  </Step>

  <Step title="Install OpenClaw">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Step>

  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    Follow the wizard. API keys are recommended over OAuth for headless devices. Telegram is the easiest channel to start with.

  </Step>

  <Step title="Verify">
    ```bash
    openclaw status
    systemctl --user status openclaw-gateway.service
    journalctl --user -u openclaw-gateway.service -f
    ```
  </Step>

  <Step title="Access the Control UI">
    On your computer, get a dashboard URL from the Pi:

    ```bash
    ssh user@gateway-host 'openclaw dashboard --no-open'
    ```

    Then create an SSH tunnel in another terminal:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 user@gateway-host
    ```

    Open the printed URL in your local browser. For always-on remote access, see [Tailscale integration](/gateway/tailscale).

  </Step>
</Steps>

## Performance tips

**Use a USB SSD** -- SD cards are slow and wear out. A USB SSD dramatically improves performance. See the [Pi USB boot guide](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#usb-mass-storage-boot).

**Enable module compile cache** -- Speeds up repeated CLI invocations on lower-power Pi hosts:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
export OPENCLAW_NO_RESPAWN=1
EOF
source ~/.bashrc
```

**Reduce memory usage** -- For headless setups, free GPU memory and disable unused services:

```bash
echo 'gpu_mem=16' | sudo tee -a /boot/config.txt
sudo systemctl disable bluetooth
```

**systemd drop-in for stable restarts** -- If this Pi is mostly running OpenClaw, add a service drop-in:

```bash
systemctl --user edit openclaw-gateway.service
```

```ini
[Service]
Environment=OPENCLAW_NO_RESPAWN=1
Environment=NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
Restart=always
RestartSec=2
TimeoutStartSec=90
```

Then `systemctl --user daemon-reload && systemctl --user restart openclaw-gateway.service`. On a headless Pi, also enable lingering once so the user service survives logout: `sudo loginctl enable-linger "$(whoami)"`.

## Recommended model setup

Since the Pi only runs the gateway, use cloud-hosted API models:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-6",
        "fallbacks": ["openai/gpt-5.4-mini"]
      }
    }
  }
}
```

Do not run local LLMs on a Pi — even small models are too slow to be useful. Let Claude or GPT do the model work.

## ARM binary notes

Most OpenClaw features work on ARM64 without changes (Node.js, Telegram, WhatsApp/Baileys, Chromium). The binaries that occasionally lack ARM builds are typically optional Go/Rust CLI tools shipped by skills. Verify a missing binary's release page for `linux-arm64` / `aarch64` artifacts before falling back to building from source.

## Persistence and backups

OpenClaw state lives under:

- `~/.openclaw/` — `openclaw.json`, per-agent `auth-profiles.json`, channel/provider state, sessions.
- `~/.openclaw/workspace/` — agent workspace (SOUL.md, memory, artifacts).

These survive reboots. Take a portable snapshot with:

```bash
openclaw backup create
```

If you keep these on an SSD, both performance and longevity improve over the SD card.

## Troubleshooting

**Out of memory** -- Verify swap is active with `free -h`. Disable unused services (`sudo systemctl disable cups bluetooth avahi-daemon`). Use API-based models only.

**Slow performance** -- Use a USB SSD instead of an SD card. Check for CPU throttling with `vcgencmd get_throttled` (should return `0x0`).

**Service will not start** -- Check logs with `journalctl --user -u openclaw-gateway.service --no-pager -n 100` and run `openclaw doctor --non-interactive`. If this is a headless Pi, also verify lingering is enabled: `sudo loginctl enable-linger "$(whoami)"`.

**ARM binary issues** -- If a skill fails with "exec format error", check whether the binary has an ARM64 build. Verify architecture with `uname -m` (should show `aarch64`).

**WiFi drops** -- Disable WiFi power management: `sudo iwconfig wlan0 power off`.

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options
- [Updating](/install/updating) -- keep OpenClaw up to date

## Related

- [Install overview](/install)
- [Linux server](/vps)
- [Platforms](/platforms)
