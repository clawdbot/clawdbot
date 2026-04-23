---
summary: "Host OpenClaw on a DigitalOcean Droplet"
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for a simple paid VPS for OpenClaw
title: "DigitalOcean"
---

Run a persistent OpenClaw Gateway on a DigitalOcean Droplet.

## Prerequisites

- DigitalOcean account ([signup](https://cloud.digitalocean.com/registrations/new))
- SSH key pair (or willingness to use password auth)
- About 20 minutes

## Setup

<Steps>
  <Step title="Create a Droplet">
    <Warning>
    Use a clean base image (Ubuntu 24.04 LTS). Avoid third-party Marketplace 1-click images unless you have reviewed their startup scripts and firewall defaults.
    </Warning>

    1. Log into [DigitalOcean](https://cloud.digitalocean.com/).
    2. Click **Create > Droplets**.
    3. Choose:
       - **Region:** Closest to you
       - **Image:** Ubuntu 24.04 LTS
       - **Size:** Basic, Regular, 1 vCPU / 1 GB RAM / 25 GB SSD
       - **Authentication:** SSH key (recommended) or password
    4. Click **Create Droplet** and note the IP address.

  </Step>

  <Step title="Connect and install">
    ```bash
    ssh root@YOUR_DROPLET_IP

    apt update && apt upgrade -y

    # Install Node.js 24
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt install -y nodejs

    # Install OpenClaw
    curl -fsSL https://openclaw.ai/install.sh | bash
    openclaw --version
    ```

  </Step>

  <Step title="Run onboarding">
    ```bash
    openclaw onboard --install-daemon
    ```

    The wizard walks you through model auth, channel setup, gateway token generation, and daemon installation (systemd).

  </Step>

  <Step title="Add swap (recommended for 1 GB Droplets)">
    ```bash
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ```
  </Step>

  <Step title="Verify the gateway">
    ```bash
    openclaw status
    systemctl --user status openclaw-gateway.service
    journalctl --user -u openclaw-gateway.service -f
    ```
  </Step>

  <Step title="Access the Control UI">
    The gateway binds to loopback by default. Pick one of these options.

    **Option A: SSH tunnel (simplest)**

    ```bash
    # From your local machine
    ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP
    ```

    Then open `http://localhost:18789`.

    **Option B: Tailscale Serve**

    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    tailscale up
    openclaw config set gateway.tailscale.mode serve
    openclaw gateway restart
    ```

    Then open `https://<magicdns>/` from any device on your tailnet.

    **Option C: Tailnet bind (no Serve)**

    ```bash
    openclaw config set gateway.bind tailnet
    openclaw gateway restart
    ```

    Then open `http://<tailscale-ip>:18789` (token required).

  </Step>
</Steps>

## Troubleshooting

**Gateway will not start** -- Run `openclaw doctor --non-interactive` and check logs with `journalctl --user -u openclaw-gateway.service -n 50`.

**Port already in use** -- Run `lsof -i :18789` to find the process, then stop it.

**Out of memory** -- Verify swap is active with `free -h`. If still hitting OOM, use API-based models (Claude, GPT) rather than local models, or upgrade to a 2 GB Droplet.

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options
- [Updating](/install/updating) -- keep OpenClaw up to date
