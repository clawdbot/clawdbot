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

The included `fly.toml` configures:

- **Region**: `lhr` (London) - change to your preferred [region](https://fly.io/docs/reference/regions/)
- **VM**: `shared-cpu-1x` with 512MB RAM (sufficient for most use cases)
- **Storage**: Persistent volume mounted at `/data`
- **Auto-scaling**: Disabled to maintain persistent connections

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

## Notes

- Fly.io uses **x86** architecture (not ARM)
- The Dockerfile is compatible with both architectures
- For WhatsApp/Telegram, you'll need to run onboarding via `fly ssh console`
