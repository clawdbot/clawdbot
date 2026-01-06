---
summary: "SSH tunnel setup for Clawdbot.app connecting to a remote gateway"
read_when: "Connecting the macOS app to a remote gateway over SSH"
---

# Running Clawdbot.app with a Remote Gateway

Clawdbot.app uses SSH tunneling to connect to a remote gateway. This guide shows you how to set it up.

## Overview

```
┌─────────────────────────────────────────────────────────────┐
│                          MacBook                              │
│                                                              │
│  Clawdbot.app ──► ws://127.0.0.1:18789 (local port)           │
│                     │                                        │
│                     ▼                                        │
│  SSH Tunnel ────────────────────────────────────────────────│
│                     │                                        │
└─────────────────────┼──────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                         Remote Machine                        │
│                                                              │
│  Gateway WebSocket ──► ws://127.0.0.1:18789 ──►              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Quick Setup

### Step 1: Add SSH Config

Edit `~/.ssh/config` and add:

```ssh
Host remote-gateway
    HostName <REMOTE_IP>          # e.g., 172.27.187.184
    User <REMOTE_USER>            # e.g., jefferson
    LocalForward 18789 127.0.0.1:18789
    IdentityFile ~/.ssh/id_rsa
```

Replace `<REMOTE_IP>` and `<REMOTE_USER>` with your values.

### Step 2: Copy SSH Key

Copy your public key to the remote machine (enter password once):

```bash
ssh-copy-id -i ~/.ssh/id_rsa <REMOTE_USER>@<REMOTE_IP>
```

### Step 3: Set Gateway Token

```bash
launchctl setenv CLAWDBOT_GATEWAY_TOKEN "<your-token>"
```

### Step 4: Start SSH Tunnel

```bash
ssh -N remote-gateway &
```

### Step 5: Restart Clawdbot.app

```bash
killall Clawdbot
open /path/to/Clawdbot.app
```

The app will now connect to the remote gateway through the SSH tunnel.

---

## Auto-Start Tunnel on Login

To have the SSH tunnel start automatically when you log in, create a Launch Agent.

### Create the PLIST file

Save this as `~/Library/LaunchAgents/com.clawdbot.ssh-tunnel.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawdbot.ssh-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/ssh</string>
        <string>-N</string>
        <string>remote-gateway</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
```

### Load the Launch Agent

```bash
launchctl load ~/Library/LaunchAgents/com.clawdbot.ssh-tunnel.plist
```

The tunnel will now:
- Start automatically when you log in
- Restart if it crashes
- Keep running in the background

---

## Troubleshooting

**Check if tunnel is running:**

```bash
ps aux | grep "ssh -N remote-gateway" | grep -v grep
lsof -i :18789
```

**Restart the tunnel:**

```bash
launchctl restart com.clawdbot.ssh-tunnel
```

**Stop the tunnel:**

```bash
launchctl unload ~/Library/LaunchAgents/com.clawdbot.ssh-tunnel.plist
```

---

## How It Works

| Component | What It Does |
|-----------|--------------|
| `LocalForward 18789 127.0.0.1:18789` | Forwards local port 18789 to remote port 18789 |
| `ssh -N` | SSH without executing remote commands (just port forwarding) |
| `KeepAlive` | Automatically restarts tunnel if it crashes |
| `RunAtLoad` | Starts tunnel when the agent loads |

Clawdbot.app connects to `ws://127.0.0.1:18789` on your MacBook. The SSH tunnel forwards that connection to port 18789 on the remote machine where the Gateway is running.
