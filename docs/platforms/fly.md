---
title: Fly.io
description: Deploy Clawdbot on Fly.io
---

# Fly.io Deployment

Deploy Clawdbot on [Fly.io](https://fly.io) with persistent storage and automatic HTTPS.

## Prerequisites

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account

## Quick Start

```bash
# Clone and enter the repo
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot

# Create the app (first time only)
fly apps create clawdbot

# Create persistent volume for data
fly volumes create clawdbot_data --size 1 --region lhr

# Set your secrets
fly secrets set ANTHROPIC_API_KEY=your-key-here
# Add other provider keys as needed

# Deploy
fly deploy
```

## Configuration

The included `fly.toml` is a starting template. Key settings to customize:

### VM Size

The default `shared-cpu-1x` with 512MB may be too small for production. Recommended:

```toml
[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"
```

### Bind Address

**Important**: The gateway must bind to `0.0.0.0` for Fly's proxy to reach it:

```toml
[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"
```

When using `--bind lan`, you must also set a gateway token for security:

```bash
fly secrets set CLAWDBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
```

### State Directory

Store persistent data on the volume:

```toml
[env]
  CLAWDBOT_STATE_DIR = "/data"
```

### Full Example

```toml
[env]
  NODE_ENV = "production"
  CLAWDBOT_PREFER_PNPM = "1"
  CLAWDBOT_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"
```

## Secrets

Set your API keys as secrets (never commit these):

```bash
fly secrets set ANTHROPIC_API_KEY=sk-...
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...
```

## Accessing the Gateway

After deployment:

```bash
# Open the web UI
fly open

# Check logs
fly logs

# SSH into the machine
fly ssh console
```

## Troubleshooting

### "App is not listening on expected address"

If you see this warning, the gateway is binding to `127.0.0.1` instead of `0.0.0.0`. Add `--bind lan` to your process command (see Configuration above).

### OOM / Memory Issues

If the container gets killed or restarts frequently, increase memory:

```toml
[[vm]]
  memory = "2048mb"
```

### Gateway Lock Issues

If the gateway refuses to start with "already running" errors after a container restart, this is a stale PID lock. The lock file persists on the volume but the process doesn't survive restarts.

**Fix**: Delete the lock file via SSH:
```bash
fly ssh console
rm /data/.clawdbot/run/gateway.*.lock
```

Then restart the machine.

## Notes

- Fly.io uses **x86** architecture (not ARM)
- The Dockerfile is compatible with both architectures
- For WhatsApp/Telegram, you'll need to run onboarding via `fly ssh console`
