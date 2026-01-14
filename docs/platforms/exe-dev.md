---
summary: "Run Clawdbot Gateway on exe.dev (VM + HTTPS proxy) for remote access"
read_when:
  - You want a cheap always-on Linux host for the Gateway
  - You want remote Control UI access without running your own VPS
---

# exe.dev

Goal: Clawdbot Gateway running on an exe.dev VM, reachable from your laptop via:
- **exe.dev HTTPS proxy** (easy, no tunnel) or
- **SSH tunnel** (most secure; loopback-only Gateway)

This page assumes **Ubuntu/Debian**. If you picked a different distro, map packages accordingly.

If you’re on any other Linux VPS, the same steps apply — you just won’t use the exe.dev proxy commands.

## Beginner quick path

1) Create VM → install Node 22 → install Clawdbot  
2) Run `clawdbot onboard --install-daemon`  
3) Tunnel from laptop (`ssh -N -L 18789:127.0.0.1:18789 …`)  
4) Open `http://127.0.0.1:18789/` and paste your token

## What you need

- exe.dev account + `ssh exe.dev` working on your laptop
- SSH keys set up (your laptop → exe.dev)
- Model auth (OAuth or API key) you want to use
- Provider credentials (optional): WhatsApp QR scan, Telegram bot token, Discord bot token, …

## 1) Create the VM

From your laptop:

```bash
ssh exe.dev new --name=clawdbot
```

Then connect:

```bash
ssh clawdbot.exe.xyz
```

Tip: keep this VM **stateful**. Clawdbot stores state under `~/.clawdbot/` and `~/clawd/`.

## 2) Install prerequisites (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

### Node 22

Install Node **>= 22.12** (any method is fine). Quick check:

```bash
node -v
```

If you don’t already have Node 22 on the VM, use your preferred Node manager (nvm/mise/asdf) or a distro package source that provides Node 22+.

Common Ubuntu/Debian option (NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 3) Install Clawdbot

Recommended on servers: npm global install.

```bash
npm i -g clawdbot@latest
clawdbot --version
```

If native deps fail to install (rare; usually `sharp`), add build tools:

```bash
sudo apt-get install -y build-essential python3
```

## 4) First-time setup (wizard)

Run the onboarding wizard on the VM:

```bash
clawdbot onboard --install-daemon
```

It can set up:
- `~/clawd` workspace bootstrap
- `~/.clawdbot/clawdbot.json` config
- model auth profiles
- model provider config/login
- Linux systemd **user** service (daemon)

If you’re doing OAuth on a headless VM: do OAuth on a normal machine first, then copy the auth profile to the VM (see [FAQ](/start/faq)).

## 5) Remote access options

### Option A (recommended): SSH tunnel (loopback-only)

Keep Gateway on loopback (default) and tunnel it from your laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 clawdbot.exe.xyz
```

Open locally:
- `http://127.0.0.1:18789/` (Control UI)

Runbook: [Remote access](/gateway/remote)

### Option B: exe.dev HTTPS proxy (no tunnel)

To let exe.dev proxy traffic to the VM, bind the Gateway to the LAN interface and set a token:

```bash
export CLAWDBOT_GATEWAY_TOKEN="$(openssl rand -hex 32)"
clawdbot gateway --bind lan --port 8080 --token "$CLAWDBOT_GATEWAY_TOKEN"
```

For daemon runs, persist it in `~/.clawdbot/clawdbot.json`:

```json5
{
  gateway: {
    mode: "local",
    port: 8080,
    bind: "lan",
    auth: { mode: "token", token: "YOUR_TOKEN" }
  }
}
```

Notes:
- Non-loopback binds require `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`).
- `gateway.remote.token` is only for remote CLI calls; it does not enable local auth.

Then point exe.dev’s proxy at `8080` (or whatever port you chose) and open your VM’s HTTPS URL:

```bash
ssh exe.dev share port clawdbot 8080
```

Open:
- `https://clawdbot.exe.xyz/`

In the Control UI, paste the token (UI → Settings → token). The UI sends it as `connect.params.auth.token`.

Notes:
- Prefer a **non-default** port (like `8080`) if your proxy expects an app port.
- Treat the token like a password.

Control UI details: [Control UI](/web/control-ui)

## 6) Keep it running (daemon)

On Linux, Clawdbot uses a systemd **user** service. After `--install-daemon`, verify:

```bash
systemctl --user status clawdbot-gateway[-<profile>].service
```

If the service dies after logout, enable lingering:

```bash
sudo loginctl enable-linger "$USER"
```

More: [Linux](/platforms/linux)

## 7) Updates

```bash
npm i -g clawdbot@latest
clawdbot doctor
clawdbot daemon restart
clawdbot health
```

Guide: [Updating](/install/updating)
