---
summary: "OpenClaw on Oracle Cloud (Always Free ARM)"
read_when:
  - Setting up OpenClaw on Oracle Cloud
  - Looking for low-cost VPS hosting for OpenClaw
  - Want 24/7 OpenClaw on a small server
title: "Oracle Cloud (platform)"
---

# OpenClaw on Oracle Cloud (OCI)

## Goal

Run a persistent OpenClaw Gateway on Oracle Cloud's **Always Free** ARM tier.

Oracle’s free tier can be a great fit for OpenClaw (especially if you already have an OCI account), but it comes with tradeoffs:

- ARM architecture (most things work, but some binaries may be x86-only)
- Capacity and signup can be finicky

## Cost Comparison (2026)

| Provider     | Plan            | Specs                  | Price/mo | Notes                 |
| ------------ | --------------- | ---------------------- | -------- | --------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0       | ARM, limited capacity |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4     | Cheapest paid option  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6       | Easy UI, good docs    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6       | Many locations        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5       | Now part of Akamai    |

---

## Prerequisites

- Oracle Cloud account ([signup](https://www.oracle.com/cloud/free/)) — see [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) if you hit issues
- Tailscale account (free at [tailscale.com](https://tailscale.com))
- ~30 minutes

## 1) Create an OCI Instance

1. Log into [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navigate to **Compute → Instances → Create Instance**
3. Configure:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (or up to 4)
   - **Memory:** 12 GB (or up to 24 GB)
   - **Boot volume:** 50 GB (up to 200 GB free)
   - **SSH key:** Add your public key
4. Click **Create**
5. Note the public IP address

**Tip:** If instance creation fails with "Out of capacity", try a different availability domain or retry later. Free tier capacity is limited.

## 2) Connect and Update

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Note:** `build-essential` is required for ARM compilation of some dependencies.

## 3) Configure User and Hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4) Install Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

This enables Tailscale SSH, so you can connect via `ssh openclaw` from any device on your tailnet — no public IP needed.

Verify:

```bash
tailscale status
```

**From now on, connect via Tailscale:** `ssh ubuntu@openclaw` (or use the Tailscale IP).

## 5) Install OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

When prompted "How do you want to hatch your bot?", select **"Do this later"**.

> Note: If you hit ARM-native build issues, start with system packages (e.g. `sudo apt install -y build-essential`) before reaching for Homebrew.

## 6) Configure Gateway (loopback + token auth) and enable Tailscale Serve

Use token auth as the default. It’s predictable and avoids needing any “insecure auth” Control UI flags.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway.service
```

`gateway.trustedProxies=["127.0.0.1"]` here is only for the local Tailscale Serve proxy's forwarded-IP/local-client handling. It is **not** `gateway.auth.mode: "trusted-proxy"`. Diff viewer routes keep fail-closed behavior in this setup: raw `127.0.0.1` viewer requests without forwarded proxy headers can return `Diff not found`. Use `mode=file` / `mode=both` for attachments, or intentionally enable remote viewers and set `plugins.entries.diffs.config.viewerBaseUrl` (or pass a proxy `baseUrl`) if you need shareable viewer links.

## 7) Verify

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway.service

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8) Lock Down VCN Security

Now that everything is working, lock down the VCN to block all traffic except Tailscale. OCI's Virtual Cloud Network acts as a firewall at the network edge — traffic is blocked before it reaches your instance.

1. Go to **Networking → Virtual Cloud Networks** in the OCI Console
2. Click your VCN → **Security Lists** → Default Security List
3. **Remove** all ingress rules except:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Keep default egress rules (allow all outbound)

This blocks SSH on port 22, HTTP, HTTPS, and everything else at the network edge. From now on, you can only connect via Tailscale.

---

## Access the Control UI

From any device on your Tailscale network:

```
https://openclaw.<tailnet-name>.ts.net/
```

Replace `<tailnet-name>` with your tailnet name (visible in `tailscale status`).

No SSH tunnel needed. Tailscale provides:

- HTTPS encryption (automatic certs)
- Authentication via Tailscale identity
- Access from any device on your tailnet (laptop, phone, etc.)

---

## Security: VCN + Tailscale (recommended baseline)

With the VCN locked down (only UDP 41641 open) and the Gateway bound to loopback, you get strong defense-in-depth: public traffic is blocked at the network edge, and admin access happens over your tailnet.

This setup often removes the _need_ for extra host-based firewall rules purely to stop Internet-wide SSH brute force — but you should still keep the OS updated, run `openclaw security audit`, and verify you aren’t accidentally listening on public interfaces.

### Already protected

| Traditional Step   | Needed?     | Why                                                                          |
| ------------------ | ----------- | ---------------------------------------------------------------------------- |
| UFW firewall       | No          | VCN blocks before traffic reaches instance                                   |
| fail2ban           | No          | No brute force if port 22 blocked at VCN                                     |
| sshd hardening     | No          | Tailscale SSH doesn't use sshd                                               |
| Disable root login | No          | Tailscale uses Tailscale identity, not system users                          |
| SSH key-only auth  | No          | Tailscale authenticates via your tailnet                                     |
| IPv6 hardening     | Usually not | Depends on your VCN/subnet settings; verify what’s actually assigned/exposed |

### Still Recommended

- **Credential permissions:** `chmod 700 ~/.openclaw`
- **Security audit:** `openclaw security audit`
- **System updates:** `sudo apt update && sudo apt upgrade` regularly
- **Monitor Tailscale:** Review devices in [Tailscale admin console](https://login.tailscale.com/admin)

### Verify Security Posture

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Fallback: SSH Tunnel

If Tailscale Serve isn't working, use an SSH tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Then open `http://localhost:18789`.

---

## Troubleshooting

### Instance creation fails ("Out of capacity")

Free tier ARM instances are popular. Try:

- Different availability domain
- Retry during off-peak hours (early morning)
- Use the "Always Free" filter when selecting shape

### Tailscale will not connect

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway will not start

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway.service -n 50
```

### Cannot reach Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway.service
```

### ARM binary issues

Some tools may not have ARM builds. Check:

```bash
uname -m  # Should show aarch64
```

Most npm packages work fine. For binaries, look for `linux-arm64` or `aarch64` releases.

---

## Persistence

All state lives in:

- `~/.openclaw/` — `openclaw.json`, per-agent `auth-profiles.json`, channel/provider state, and session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, artifacts)

Back up periodically:

```bash
openclaw backup create
```

---

## Related

- [Gateway remote access](/gateway/remote) — other remote access patterns
- [Tailscale integration](/gateway/tailscale) — full Tailscale docs
- [Gateway configuration](/gateway/configuration) — all config options
- [DigitalOcean guide](/platforms/digitalocean) — if you want paid + easier signup
- [Hetzner guide](/install/hetzner) — Docker-based alternative
