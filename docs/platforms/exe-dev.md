---
summary: "Run Moltbot Gateway on exe.dev (VM + HTTPS proxy) for remote access"
read_when:
  - You want a cheap always-on Linux host for the Gateway
  - You want remote Control UI access without running your own VPS
---

# exe.dev

Goal: Moltbot Gateway running on an exe.dev VM, reachable from your laptop via: `https://<vm-name>.exe.xyz`

This page assumes exe.dev's default **exeuntu** image. If you picked a different distro, map packages accordingly.

## Beginner quick path

1) [https://exe.new/moltbot](https://exe.new/moltbot)
2) Fill in your auth key/token as needed
3) Click on "Agent" next to your VM, and wait...
4) ???
5) Profit

## What you need

- exe.dev account
- `ssh exe.dev` access to [exe.dev](https://exe.dev) virtual machines (optional)


## Automated Install with Shelley

Shelley, [exe.dev](https://exe.dev)'s agent, can install Moltbot instantly with our
prompt. The prompt used is as below:

```
Set up Moltbot (https://docs.molt.bot/install) on this VM. Use the non-interactive and accept-risk flags for moltbot onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "moltbot devices list" and "moltbot device approve <request id>". Make sure the dashboard shows that Moltbot's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manual installation

## 1) Create the VM

From your device:

```bash
ssh exe.dev new 
```

Then connect:

```bash
ssh <vm-name>.exe.xyz
```

Tip: keep this VM **stateful**. Moltbot stores state under `~/.clawdbot/` and `~/clawd/`.

## 2) Install prerequisites (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Install Moltbot

Run the Moltbot install script:

```bash
curl -fsSL https://molt.bot/install.sh | bash
```

## 4) Setup nginx to proxy Moltbot to port 8000

Edit `/etc/nginx/sites-enabled/default` with

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) Access Moltbot and grant privileges

Access `https://<vm-name>.exe.xyz/?token=YOUR-TOKEN-FROM-TERMINAL`. Approve
devices with `moltbot devices list` and `moltbot device approve`. When in doubt,
use Shelley from your browser!

## Remote Access

Remote access is handled by [exe.dev](https://exe.dev)'s authentication. By
default, HTTP traffic from port 8000 is forwarded to `https://<vm-name>.exe.xyz`
with email auth. 

## Updating

```bash
npm i -g moltbot@latest
moltbot doctor
moltbot gateway restart
moltbot health
```

Guide: [Updating](/install/updating)
