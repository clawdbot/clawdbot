---
summary: "Host OpenClaw on an NVIDIA Jetson for always-on self-hosting with optional local models"
read_when:
  - Setting up OpenClaw on an NVIDIA Jetson
  - Running OpenClaw on ARM64 edge hardware
  - Building an always-on personal AI that can also serve local models
title: "NVIDIA Jetson"
---

Run a persistent, always-on OpenClaw Gateway on an NVIDIA Jetson. Like any other host, the Jetson runs the gateway while models run in the cloud via API -- but unlike a Raspberry Pi, a Jetson also has an integrated GPU, so serving small local models from the same box is practical if you want it.

## Hardware compatibility

| Jetson module          | RAM      | Works? | Notes                                                         |
| ---------------------- | -------- | ------ | ------------------------------------------------------------- |
| AGX Orin               | 32/64 GB | Best   | Ample headroom for local models alongside the gateway.        |
| Orin NX                | 8/16 GB  | Great  | Comfortable for gateway + a small local model.                |
| Orin Nano (Super)      | 8 GB     | Great  | Gateway is light; 8 GB is the practical floor for local LLMs. |
| Orin Nano              | 4 GB     | Good   | Fine for the gateway. Too tight for local models.             |
| Xavier NX / AGX Xavier | 8/16 GB  | OK     | Works on JetPack 5 (Ubuntu 20.04); older Node packaging.      |
| Nano (original, 2019)  | 2/4 GB   | No     | Stuck on JetPack 4 / Ubuntu 18.04 -- not recommended.         |

**Minimum:** 4 GB RAM, 500 MB free disk, 64-bit JetPack (Ubuntu 20.04 or newer).
**Recommended:** 8 GB+ RAM, NVMe SSD, Ethernet, JetPack 6 (Ubuntu 22.04).

## Prerequisites

- A Jetson developer kit or module on a carrier board
- JetPack 6 (L4T R36.x, Ubuntu 22.04) -- JetPack 5 works, see notes below
- NVMe SSD recommended; a microSD card works but is slower and wears out
- The power supply that shipped with your kit (undervolting causes hard-to-debug instability)
- Network connection (Ethernet recommended for an always-on host)
- About 30 minutes

## Setup

<Steps>
  <Step title="Flash JetPack">
    Flash your board with [NVIDIA SDK Manager](https://developer.nvidia.com/sdk-manager) or the [JetPack SD-card images](https://developer.nvidia.com/embedded/jetpack). Choose **JetPack 6** where your module supports it.

    Prefer NVMe over microSD if your carrier board has an M.2 slot -- it is substantially faster and far more durable for an always-on host.

    Confirm what you are running:

    ```bash
    cat /etc/nv_tegra_release   # L4T release (R36.x = JetPack 6)
    uname -m                    # aarch64
    ```

  </Step>

  <Step title="Connect via SSH">
    ```bash
    ssh user@jetson-host
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

  <Step title="Install Node.js">
    JetPack ships Ubuntu's older Node, so install a current release from NodeSource. The `arm64` packages are the ones you want -- no build step required.

    ```bash
    curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
    sudo apt install -y nodejs
    node --version
    ```

  </Step>

  <Step title="Check swap">
    JetPack enables **zram** (compressed RAM swap) by default rather than disk swap. That is fine for the gateway alone. If you plan to run local models as well, add real swap on the SSD:

    ```bash
    swapon --show                 # JetPack default: /dev/zram0, /dev/zram1

    sudo fallocate -l 8G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
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

  <Step title="Enable lingering (required for headless)">
    The gateway runs as a `systemd --user` service, and user services stop when the last session for that user ends. Jetson images ship with lingering **disabled**, so enable it once or the gateway will not survive logout or reboot:

    ```bash
    sudo loginctl enable-linger "$(whoami)"
    loginctl show-user "$(whoami)" | grep Linger   # expect Linger=yes
    ```

  </Step>

  <Step title="Verify">
    ```bash
    openclaw status
    systemctl --user status openclaw-gateway.service
    journalctl --user -u openclaw-gateway.service -f
    ```
  </Step>

  <Step title="Access the Control UI">
    On your computer, get a dashboard URL from the Jetson:

    ```bash
    ssh user@jetson-host 'openclaw dashboard --no-open'
    ```

    Then create an SSH tunnel in another terminal:

    ```bash
    ssh -N -L 18789:127.0.0.1:18789 user@jetson-host
    ```

    Open the printed URL in your local browser. For always-on remote access, see [Tailscale integration](/gateway/tailscale).

  </Step>
</Steps>

## Performance tips

**Set the power mode** -- Jetsons can run in a reduced power profile. Mode numbers are **not** consistent across modules, so list them and pick the unrestricted one rather than assuming an ID (on Orin Nano Super, `0` is the 15 W mode and `2` is `MAXN_SUPER`):

```bash
sudo nvpmodel -q                                  # current mode
grep POWER_MODEL /etc/nvpmodel.conf               # available modes for this module
sudo nvpmodel -m <id-of-unrestricted-mode>
sudo jetson_clocks                                # optional: pin clocks to max (raises idle power and heat)
```

**Use NVMe, not microSD** -- SD cards are slow and wear out under a database-backed workload. If the OS must stay on SD, at least point `OPENCLAW_STATE_DIR` at the SSD.

**Watch thermals** -- `tegrastats` reports per-zone temperatures and throttling live. Passively cooled modules in enclosures throttle under sustained load; keep a fan on it if you enable `jetson_clocks`.

**Enable module compile cache** -- Speeds up repeated CLI invocations on lower-power hosts:

```bash
grep -q 'NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache' ~/.bashrc || cat >> ~/.bashrc <<'EOF' # pragma: allowlist secret
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
mkdir -p /var/tmp/openclaw-compile-cache
EOF
source ~/.bashrc
```

## Recommended model setup

The gateway itself is light, so cloud-hosted API models are the simplest and strongest default:

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

Unlike a Raspberry Pi, a Jetson's integrated GPU can also serve **small local models** from the same box -- useful for offline or privacy-sensitive setups. Point OpenClaw at any OpenAI-compatible endpoint you run locally, exactly as you would with a remote provider. Keep expectations realistic: an 8 GB module comfortably serves small quantized models, while larger models need a 16 GB+ module. Run the gateway on API models first and add a local endpoint once the box is stable.

## ARM binary notes

Jetson is `aarch64`, so the same ARM64 considerations as any other 64-bit ARM host apply. Node.js, the gateway, and its native modules ship ARM64 prebuilds, so no compilation is needed. The binaries that occasionally lack ARM builds are typically optional Go/Rust CLI tools shipped by skills. Verify architecture with `uname -m` (should show `aarch64`), then check a missing binary's release page for `linux-arm64` / `aarch64` artifacts before falling back to building from source.

Note that CUDA, cuDNN, and TensorRT come from JetPack and are Jetson-specific builds -- do not install desktop `x86_64` NVIDIA packages or generic CUDA `.deb`s on these boards.

## Persistence and backups

OpenClaw state lives under:

- `~/.openclaw/` -- `openclaw.json`, per-agent `auth-profiles.json`, channel/provider state, sessions.
- `~/.openclaw/workspace/` -- agent workspace (SOUL.md, memory, artifacts).

These survive reboots and benefit from NVMe over microSD for both performance and longevity. Take a portable snapshot with:

```bash
openclaw backup create
```

## Troubleshooting

**Service does not survive logout or reboot** -- Enable lingering: `sudo loginctl enable-linger "$(whoami)"`, then confirm with `loginctl show-user "$(whoami)" | grep Linger`. This is the most common Jetson-specific setup miss.

**Service will not start** -- Check logs with `journalctl --user -u openclaw-gateway.service --no-pager -n 100` and run `openclaw doctor --non-interactive`.

**Out of memory** -- Check `free -h` and `swapon --show`. JetPack's default zram is small; add disk swap (see setup) if you run local models. Use API-based models only on 4 GB modules.

**Throttling or random slowdowns** -- Run `tegrastats` and watch for thermal throttling. Confirm the power mode with `sudo nvpmodel -q`, and verify you are using the supplied power supply -- undervolting presents as random instability rather than a clean error.

**ARM binary issues** -- If a skill fails with "exec format error", check whether the binary has an ARM64 build. Verify architecture with `uname -m` (should show `aarch64`).

**Node install pulls the wrong architecture** -- Make sure you used the NodeSource script above and that `node -p "process.arch"` reports `arm64`.

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options
- [Updating](/install/updating) -- keep OpenClaw up to date

## Related

- [Install overview](/install)
- [Raspberry Pi](/install/raspberry-pi)
- [Linux server](/vps)
- [Platforms](/platforms)
