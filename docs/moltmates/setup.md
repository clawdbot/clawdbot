---
summary: "Moltmates Setup Guide - Step by step installation"
read_when:
  - Installing Moltmates for the first time
  - Setting up multi-user deployment
---

# 🛠️ Moltmates Setup Guide

> Complete step-by-step installation for Moltmates multi-user deployment.

---

## Prerequisites

### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Disk | 20 GB | 50+ GB SSD |
| OS | Linux (Debian/Ubuntu) | Ubuntu 22.04+ |

### Software Requirements

```bash
# Node.js ≥22
node --version  # Should be 22.x+

# Docker
docker --version  # Should be 20.x+

# pnpm (recommended)
pnpm --version  # Or npm/bun
```

### Install Prerequisites (Ubuntu/Debian)

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in

# pnpm
npm install -g pnpm
```

---

## Step 1: Clone Repository

```bash
cd ~
git clone https://github.com/YOUR_FORK/moltmates
cd moltmates
```

Or if forking from upstream:

```bash
git clone https://github.com/moltbot/moltbot moltmates
cd moltmates
```

---

## Step 2: Install Dependencies

```bash
pnpm install
```

This installs all Node.js dependencies.

---

## Step 3: Build Moltmates

```bash
pnpm build
```

Creates the `dist/` directory with compiled code.

---

## Step 4: Build Sandbox Image

The Docker sandbox isolates user agents:

```bash
docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .
```

### Verify image:

```bash
docker images | grep moltmate-sandbox
# Should show: moltmate-sandbox   bookworm-slim   ...
```

### Customize sandbox (optional):

Edit `Dockerfile.sandbox` to add tools:

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    poppler-utils \
    imagemagick \
    ffmpeg \
    # Add more packages here
    && rm -rf /var/lib/apt/lists/*
```

Rebuild after changes:
```bash
docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .
```

---

## Step 5: Create Configuration

```bash
# Create config directory
mkdir -p ~/.moltmate

# Copy example config
cp moltmate.example.json ~/.moltmate/moltmate.json

# Edit config
nano ~/.moltmate/moltmate.json
```

### Minimal Configuration

```json
{
  "gateway": {
    "port": 18790,
    "bind": "127.0.0.1"
  },
  "agents": {
    "main": {
      "model": "anthropic/claude-sonnet-4-5",
      "provider": "anthropic"
    }
  },
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "allowlist",
      "allowFrom": ["YOUR_TELEGRAM_ID"]
    }
  },
  "sandbox": {
    "mode": "all",
    "scope": "session",
    "workspaceAccess": "rw"
  },
  "tools": {
    "allow": ["read", "write", "edit", "exec", "web_search", "web_fetch"],
    "exec": {
      "security": "allowlist",
      "safeBins": ["cat", "head", "tail", "grep", "wc", "ls"]
    }
  }
}
```

### Environment Variables

Create `.env` file or export:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export TELEGRAM_BOT_TOKEN="123456:ABC..."
```

---

## Step 6: Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`
3. Choose name and username
4. Copy the token (looks like `123456789:ABCdefGHI...`)
5. Add to config as `TELEGRAM_BOT_TOKEN`

### Get Your Telegram ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy your numeric ID
3. Add to `allowFrom` array

---

## Step 7: Test Run

```bash
# Development mode (foreground)
pnpm dev
```

You should see:
```
Gateway starting on 127.0.0.1:18790
Telegram connected
Ready for messages
```

Test by messaging your bot on Telegram!

---

## Step 8: Production Setup (systemd)

### Create Service File

```bash
sudo nano /etc/systemd/system/moltmate.service
```

```ini
[Unit]
Description=Moltmates Gateway
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/moltmates
Environment=NODE_ENV=production
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=TELEGRAM_BOT_TOKEN=123456:ABC...
ExecStart=/usr/bin/node dist/cli.js gateway
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Enable & Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable moltmate
sudo systemctl start moltmate

# Check status
sudo systemctl status moltmate

# View logs
sudo journalctl -u moltmate -f
```

---

## Step 9: Add Users

### Add to Allowlist

Edit config to add user IDs:

```json
"channels": {
  "telegram": {
    "allowFrom": [
      "YOUR_ID",
      "FRIEND_ID",
      "FAMILY_ID"
    ]
  }
}
```

### Restart to Apply

```bash
sudo systemctl restart moltmate
```

### Verify User Workspaces

After users message the bot:

```bash
ls ~/.moltmate/users/
# Should show: telegram_123456  telegram_789012  etc.
```

---

## Step 10: Customize Personas (Optional)

### Edit Persona Templates

```bash
# Cami persona
nano /root/moltmates/templates/souls/cami.md

# Molty persona  
nano /root/moltmates/templates/souls/molty.md

# Custom template
nano /root/moltmates/templates/souls/custom.md
```

### Rebuild After Changes

```bash
cd /root/moltmates
pnpm build
sudo systemctl restart moltmate
```

---

## Verification Checklist

- [ ] Node.js ≥22 installed
- [ ] Docker running
- [ ] Sandbox image built
- [ ] Config file created
- [ ] API keys set
- [ ] Telegram bot created
- [ ] Your ID in allowFrom
- [ ] Gateway starts without errors
- [ ] Bot responds to messages
- [ ] User workspace created in `~/.moltmate/users/`

---

## Next Steps

- [Add more users](/moltmates/faq#how-do-i-add-a-new-user)
- [Customize personas](/moltmates/personas)
- [Configure security](/moltmates/security)
- [Set up skills](/moltmates/skills)

---

## Troubleshooting

### Gateway won't start

```bash
# Check logs
journalctl -u moltmate -n 50

# Common issues:
# - Port already in use: change gateway.port
# - Invalid config: validate JSON
# - Missing env vars: check ANTHROPIC_API_KEY, etc.
```

### Docker sandbox fails

```bash
# Check Docker is running
docker ps

# Rebuild image
docker build -f Dockerfile.sandbox -t moltmate-sandbox:bookworm-slim .

# Check for orphan containers
docker ps -a | grep moltmate
```

### Bot doesn't respond

1. Verify bot token is correct
2. Check user ID is in allowFrom
3. Verify gateway is running
4. Check logs for errors

---

**Setup complete! 🎉**

Your Moltmates server is now ready to serve multiple users with isolated AI assistants.
