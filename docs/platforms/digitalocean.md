---
summary: "Clawdbot on DigitalOcean (cheapest paid VPS option)"
read_when:
  - Setting up Clawdbot on DigitalOcean
  - Looking for cheap VPS hosting for Clawdbot
---

# Clawdbot on DigitalOcean

## Goal

Run a persistent Clawdbot Gateway on DigitalOcean for **$6/month** (or $4/mo with reserved pricing).

If you want something even cheaper, see [Oracle Cloud (Free Tier)](#oracle-cloud-free-alternative) at the bottom — it's **actually free forever**.

## Cost Comparison (2026)

| Provider | Plan | Specs | Price/mo | Notes |
|----------|------|-------|----------|-------|
| **Oracle Cloud** | Always Free ARM | 4 OCPU, 24GB RAM | **$0** | Best value, requires ARM-compatible setup |
| **Hetzner** | CX22 | 2 vCPU, 4GB RAM | €3.79 (~$4) | Cheapest paid, EU datacenters |
| **DigitalOcean** | Basic | 1 vCPU, 1GB RAM | $6 | Easy UI, good docs |
| **Vultr** | Cloud Compute | 1 vCPU, 1GB RAM | $6 | Many locations |
| **Linode** | Nanode | 1 vCPU, 1GB RAM | $5 | Now part of Akamai |

**Recommendation:** 
- **Free:** Oracle Cloud ARM (if you can handle the signup process)
- **Paid:** Hetzner CX22 (best specs per dollar) — see [Hetzner guide](/platforms/hetzner)
- **Easy:** DigitalOcean (this guide) — beginner-friendly UI

---

## Prerequisites

- DigitalOcean account ([signup with $200 free credit](https://m.do.co/c/signup))
- SSH key pair (or willingness to use password auth)
- ~20 minutes

## 1) Create a Droplet

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

## 3) Install Clawdbot

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install Clawdbot
curl -fsSL https://clawd.bot/install.sh | bash

# Verify
clawdbot --version
```

## 4) Run Onboarding

```bash
clawdbot onboard --install-daemon
```

The wizard will walk you through:
- Model auth (API keys or OAuth)
- Channel setup (Telegram, WhatsApp, Discord, etc.)
- Gateway token (auto-generated)
- Daemon installation (systemd)

## 5) Verify the Gateway

```bash
# Check status
clawdbot status

# Check service
systemctl --user status clawdbot-gateway.service

# View logs
journalctl --user -u clawdbot-gateway.service -f
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
clawdbot config set gateway.tailscale.mode serve
clawdbot gateway restart
```

Open: `https://<magicdns>/`

Notes:
- Serve keeps the Gateway loopback-only and authenticates via Tailscale identity headers.
- To require token/password instead, set `gateway.auth.allowTailscale: false` or use `gateway.auth.mode: "password"`.

**Option C: Tailnet bind (no Serve)**
```bash
clawdbot config set gateway.bind tailnet
clawdbot gateway restart
```

Open: `http://<tailscale-ip>:18789` (token required).

## 7) Connect Your Channels

### Telegram
```bash
clawdbot pairing list telegram
clawdbot pairing approve telegram <CODE>
```

### WhatsApp
```bash
clawdbot channels login whatsapp
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
- `~/.clawdbot/` — config, credentials, session data
- `~/clawd/` — workspace (SOUL.md, memory, etc.)

These survive reboots. Back them up periodically:
```bash
tar -czvf clawdbot-backup.tar.gz ~/.clawdbot ~/clawd
```

---

## Oracle Cloud Free Alternative

Oracle Cloud offers **Always Free** ARM instances that are significantly more powerful:

| What you get | Specs |
|--------------|-------|
| **4 OCPUs** | ARM Ampere A1 |
| **24GB RAM** | More than enough |
| **200GB storage** | Block volume |
| **Forever free** | No credit card charges |

### Quick setup:
1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/)
2. Create a VM.Standard.A1.Flex instance (ARM)
3. Choose Oracle Linux or Ubuntu
4. Allocate up to 4 OCPU / 24GB RAM within free tier
5. Follow the same Clawdbot install steps above

**Caveats:**
- Signup can be finicky (retry if it fails)
- ARM architecture — most things work, but some binaries need ARM builds
- Oracle may reclaim idle instances (keep them active)

For the full Oracle guide, see the [community docs](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Troubleshooting

### Gateway won't start
```bash
clawdbot gateway status
clawdbot doctor --non-interactive
journalctl -u clawdbot --no-pager -n 50
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

## See Also

- [Hetzner guide](/platforms/hetzner) — cheaper, more powerful
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — secure remote access
- [Configuration](/gateway/configuration) — full config reference
