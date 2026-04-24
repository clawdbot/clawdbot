---
summary: "OpenClaw on DigitalOcean (simple paid VPS option)"
read_when:
  - Setting up OpenClaw on DigitalOcean
  - Looking for cheap VPS hosting for OpenClaw
title: "DigitalOcean (platform)"
---

# OpenClaw on DigitalOcean

## Goal

Run a persistent OpenClaw Gateway on DigitalOcean for **$6/month** (or $4/mo with reserved pricing).

If you want a $0/month option and don’t mind ARM + provider-specific setup, see the [Oracle Cloud guide](/platforms/oracle).

## Cost Comparison (2026)

| Provider     | Plan            | Specs                  | Price/mo    | Notes                                 |
| ------------ | --------------- | ---------------------- | ----------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0          | ARM, limited capacity / signup quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6          | Easy UI, good docs                    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6          | Many locations                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5          | Now part of Akamai                    |

**Picking a provider:**

- DigitalOcean: simplest UX + predictable setup (this guide)
- Hetzner: good price/perf (see [Hetzner guide](/install/hetzner))
- Oracle Cloud: can be $0/month, but is more finicky and ARM-only (see [Oracle guide](/platforms/oracle))

---

## Prerequisites

- DigitalOcean account ([signup with $200 free credit](https://m.do.co/c/signup))
- SSH key pair (or willingness to use password auth)
- ~20 minutes

## 1) Create a Droplet

<Warning>
Use a clean base image (Ubuntu 24.04 LTS). Avoid third-party Marketplace 1-click images unless you have reviewed their startup scripts and firewall defaults.
</Warning>

1. Log into [DigitalOcean](https://cloud.digitalocean.com/)
2. Click **Create → Droplets**
3. Choose:
   - **Region:** Closest to you (or your users)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (recommended) or password
4. Click **Create Droplet**
5. Note the IP address

## 2) Connect via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3) Install OpenClaw

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4) Run Onboarding

```bash
openclaw onboard --install-daemon
```

The wizard will walk you through:

- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

## 5) Verify the Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6) Access the Dashboard

The gateway binds to loopback by default. To access the Control UI:

**Option A: SSH Tunnel (recommended)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Option B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Open: `https://<magicdns>/`

Notes:

- Serve keeps the Gateway loopback-only and authenticates Control UI/WebSocket traffic via Tailscale identity headers (tokenless auth assumes trusted gateway host; HTTP APIs do not use those Tailscale headers and instead follow the gateway's normal HTTP auth mode).
- To require explicit shared-secret credentials instead, set `gateway.auth.allowTailscale: false` and use `gateway.auth.mode: "token"` or `"password"`.

**Option C: Tailnet bind (no Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

## 7) Connect Your Channels

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

See [Channels](/channels) for other providers.

---

## Optimizations for 1GB RAM

The $6 droplet only has 1GB RAM. To keep things running smoothly:

### Add swap (recommended)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Use a lighter model

If you're hitting OOMs, consider:

- Using API-based models (Claude, GPT) instead of local models
- Setting `agents.defaults.model.primary` to a smaller model

### Monitor memory

```bash
free -h
htop
```

---

## Persistence

All state lives in:

- `~/.openclaw/` — `openclaw.json`, per-agent `auth-profiles.json`, channel/provider state, and session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, etc.)

These survive reboots. Back them up periodically:

```bash
openclaw backup create
```

---

## Oracle Cloud Free Alternative

Oracle Cloud offers **Always Free** ARM instances that are significantly more powerful than any paid option here — for $0/month.

| What you get      | Specs                  |
| ----------------- | ---------------------- |
| **4 OCPUs**       | ARM Ampere A1          |
| **24GB RAM**      | More than enough       |
| **200GB storage** | Block volume           |
| **Forever free**  | No credit card charges |

**Caveats:**

- Signup can be finicky (retry if it fails)
- ARM architecture — most things work, but some binaries need ARM builds

For the full setup guide, see [Oracle Cloud](/platforms/oracle). For signup tips and troubleshooting the enrollment process, see this [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Troubleshooting

### Gateway will not start

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway.service --no-pager -n 50
```

### Port already in use

```bash
lsof -i :18789
kill <PID>
```

### Out of memory

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Related

- [Hetzner guide](/install/hetzner) — cheaper, more powerful
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — secure remote access
- [Configuration](/gateway/configuration) — full config reference
