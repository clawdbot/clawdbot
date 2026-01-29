---
title: Deploy on Zeabur
summary: "Deploy moltbot on Zeabur with one click"
read_when:
  - Deploying to Zeabur
  - Looking for one-click cloud deployment
  - Using Zeabur AI Hub
---

Deploy moltbot on [Zeabur](https://zeabur.com) with a one-click template and finish setup in your browser.
Zeabur runs the Gateway for you, and you configure everything via the dashboard.

## One-click deploy

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/VTZ4FX)

Click the button above, fill in your domain and API keys, and you're done.

## Recommended resources

Resource requirements may vary depending on the tools and features you use.

- **Shared Cluster**: 2 vCPU, 2 GB RAM
- **Dedicated Server**: Recommended for better performance

## 1) Deploy the template

1. Click **Deploy on Zeabur** button above
2. Fill in the variables:
   - **Domain**: Your preferred subdomain (e.g., `my-moltbot.zeabur.app`)
   - **Zeabur AI Hub API Key** (recommended): Get from [Zeabur AI Hub](https://zeabur.com/docs/ai-hub)
   - **Anthropic API Key** (optional): Your Claude API key
   - **OpenAI API Key** (optional): For memory search, TTS features
3. Choose deployment target:
   - **Server Type**: Flex Shared Cluster (shared resources, cost-effective) or Dedicated Server (purchase from Zeabur or connect your own)
   - **Region**: Pick a region closest to you (e.g., Tokyo, Taipei, California)
4. Click **Confirm**

## 2) Access the Gateway

After deployment completes:

1. Go to your service's **Instructions** tab
2. Click the **Web UI (with token)** link — the URL includes your domain and auth token (e.g., `https://<your-domain>.zeabur.app?token=...`)
3. Check the **Overview** page to verify the Gateway is connected
4. Go to **Chat** to test your API key

## 3) Connect Telegram

### Get a bot token

1. Message `@BotFather` in Telegram
2. Run `/newbot`
3. Copy the token (looks like `123456789:AA...`)
4. Go to your service's **Variable** tab in Zeabur
5. Add `TELEGRAM_BOT_TOKEN` with your token
6. Restart the service

### Pair your Telegram account

1. Send `/start` to your bot in Telegram
2. The bot replies with a pairing code (e.g., `JN4MSY23`)
3. Open **Command** in Zeabur dashboard
4. Run: `moltbot pairing approve telegram <code>`
5. Start chatting!

## 4) Additional configuration

Beyond environment variables, you can configure moltbot using:

**Web UI**

1. Open the moltbot Web UI
2. Go to Settings to configure models, channels, and preferences

**Command Line**

1. Open **Command** in Zeabur dashboard
2. Use `moltbot` commands to manage providers, models, and settings

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZEABUR_AI_HUB_API_KEY` | Recommended | Zeabur AI Hub key for Gemini/GPT/Claude/DeepSeek |
| `ANTHROPIC_API_KEY` | Optional | Direct Anthropic API access |
| `OPENAI_API_KEY` | Optional | For memory search, TTS, embeddings |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram bot token from @BotFather |

## Data persistence

The template mounts two persistent volumes:

| Path | Purpose |
|------|---------|
| `/home/node/.clawdbot` | Configuration, sessions, credentials |
| `/home/node/clawd` | Workspace and memory files |

Your config and sessions persist across restarts and redeployments.

## Troubleshooting

### Gateway not starting

Check the logs in Zeabur dashboard. Common issues:

- Missing API keys: Add at least one model provider key
- Port conflict: The template uses port 18789 by default

### Cannot connect to Web UI

- Verify the domain is bound correctly in **Networking** tab
- Check that the service is running (green status)
- Try the direct URL from **Instructions** tab

### Telegram bot not responding

1. Verify `TELEGRAM_BOT_TOKEN` is set correctly
2. Check if the bot is paired: Open **Command** and run `moltbot pairing list`
3. If not paired, send `/start` to your bot and approve the pairing code

### Config changes not applied

The config file is only created on first startup. To modify:

1. Open **Command** in Zeabur dashboard
2. Edit `/home/node/.clawdbot/clawdbot.json`
3. Restart the service

Or use the Web UI Settings page.

## Updates

The template uses the `main` tag which always pulls the latest version. To update:

1. Go to your service in Zeabur dashboard
2. Click **Redeploy**

Your data persists on the volumes.

For production use, consider pinning to a specific version tag (e.g., `2026.1.24`) to avoid unexpected changes. You can change the image tag in Zeabur's service settings.

## Cost

With the recommended config (2 vCPU, 2 GB RAM):

- Shared Cluster: ~$5-10/month depending on usage
- See [Zeabur Pricing](https://zeabur.com/pricing) for details

## Notes

- Zeabur AI Hub provides access to multiple models (Gemini, GPT, Claude, DeepSeek) with a single API key
- The template uses `--allow-unconfigured` so startup requirements can be configured via environment variables
