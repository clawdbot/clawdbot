---
summary: "Host OpenClaw on Oracle Cloud's Always Free ARM tier"
read_when:
  - Setting up OpenClaw on Oracle Cloud
  - Looking for free VPS hosting for OpenClaw
  - Want 24/7 OpenClaw on a small server
title: "Oracle Cloud"
---

Run a persistent OpenClaw Gateway on Oracle Cloud's **Always Free** ARM tier (up to 4 OCPU, 24 GB RAM, 200 GB storage) at no cost.

## Prerequisites

- Oracle Cloud account ([signup](https://www.oracle.com/cloud/free/)) -- see [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) if you hit issues
- Tailscale account (free at [tailscale.com](https://tailscale.com))
- An SSH key pair
- About 30 minutes

## Setup

<Steps>
  <Step title="Create an OCI instance">
    1. Log into [Oracle Cloud Console](https://cloud.oracle.com/).
    2. Navigate to **Compute > Instances > Create Instance**.
    3. Configure:
       - **Name:** `openclaw`
       - **Image:** Ubuntu 24.04 (aarch64)
       - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
       - **OCPUs:** 2 (or up to 4)
       - **Memory:** 12 GB (or up to 24 GB)
       - **Boot volume:** 50 GB (up to 200 GB free)
       - **SSH key:** Add your public key
    4. Click **Create** and note the public IP address.

    <Tip>
    If instance creation fails with "Out of capacity", try a different availability domain or retry later. Free tier capacity is limited.
    </Tip>

  </Step>

  <Step title="Connect and update the system">
    ```bash
    ssh ubuntu@YOUR_PUBLIC_IP

    sudo apt update && sudo apt upgrade -y
    sudo apt install -y build-essential
    ```

    `build-essential` is required for ARM compilation of some dependencies.

  </Step>

  <Step title="Configure user and hostname">
    ```bash
    sudo hostnamectl set-hostname openclaw
    sudo passwd ubuntu
    sudo loginctl enable-linger ubuntu
    ```

    Enabling linger keeps user services running after logout.

  </Step>

  <Step title="Install Tailscale">
    ```bash
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh --hostname=openclaw
    ```

    From now on, connect via Tailscale: `ssh ubuntu@openclaw`.

  </Step>

  <Step title="Install OpenClaw">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    source ~/.bashrc
    ```

    When prompted "How do you want to hatch your bot?", select **Do this later**.

  </Step>

  <Step title="Configure the gateway">
    Use token auth with Tailscale Serve for secure remote access.

    ```bash
    openclaw config set gateway.bind loopback
    openclaw config set gateway.auth.mode token
    openclaw doctor --generate-gateway-token
    openclaw config set gateway.tailscale.mode serve
    openclaw config set gateway.trustedProxies '["127.0.0.1"]'

    systemctl --user restart openclaw-gateway.service
    ```

    `gateway.trustedProxies=["127.0.0.1"]` here is only for the local Tailscale Serve proxy's forwarded-IP/local-client handling. It is **not** `gateway.auth.mode: "trusted-proxy"`. Diff viewer routes keep fail-closed behavior in this setup: raw `127.0.0.1` viewer requests without forwarded proxy headers can return `Diff not found`. Use `mode=file` / `mode=both` for attachments, or intentionally enable remote viewers and set `plugins.entries.diffs.config.viewerBaseUrl` (or pass a proxy `baseUrl`) if you need shareable viewer links.

  </Step>

  <Step title="Lock down VCN security">
    Block all traffic except Tailscale at the network edge:

    1. Go to **Networking > Virtual Cloud Networks** in the OCI Console.
    2. Click your VCN, then **Security Lists > Default Security List**.
    3. **Remove** all ingress rules except `0.0.0.0/0 UDP 41641` (Tailscale).
    4. Keep default egress rules (allow all outbound).

    This blocks SSH on port 22, HTTP, HTTPS, and everything else at the network edge. You can only connect via Tailscale from this point on.

  </Step>

  <Step title="Verify">
    ```bash
    openclaw --version
    systemctl --user status openclaw-gateway.service
    tailscale serve status
    curl http://localhost:18789
    ```

    Access the Control UI from any device on your tailnet:

    ```
    https://openclaw.<tailnet-name>.ts.net/
    ```

    Replace `<tailnet-name>` with your tailnet name (visible in `tailscale status`).

  </Step>
</Steps>

## Fallback: SSH tunnel

If Tailscale Serve is not working, use an SSH tunnel from your local machine:

```bash
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Then open `http://localhost:18789`.

## Troubleshooting

**Instance creation fails ("Out of capacity")** -- Free tier ARM instances are popular. Try a different availability domain or retry during off-peak hours.

**Tailscale will not connect** -- Run `sudo tailscale up --ssh --hostname=openclaw --reset` to re-authenticate.

**Gateway will not start** -- Run `openclaw doctor --non-interactive` and check logs with `journalctl --user -u openclaw-gateway.service -n 50`.

**ARM binary issues** -- Most npm packages work on ARM64. For native binaries, look for `linux-arm64` or `aarch64` releases. Verify architecture with `uname -m`.

## Next steps

- [Channels](/channels) -- connect Telegram, WhatsApp, Discord, and more
- [Gateway configuration](/gateway/configuration) -- all config options
- [Updating](/install/updating) -- keep OpenClaw up to date
