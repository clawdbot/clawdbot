# Google Chat Bot Configuration Guide

## Overview

This guide shows how to set up a Google Chat bot using HTTP webhooks (the standard method for new bots) or Pub/Sub (for existing bots).

## Prerequisites

- Google Cloud Project
- Service account credentials with Google Chat API access
- Public webhook endpoint (for webhook mode) OR Pub/Sub subscription (for legacy mode)

## Configuration Steps

### 1. Create Google Cloud Project

1. Visit: https://console.cloud.google.com/
2. Create a new project or select existing project
3. Note your project ID

### 2. Enable Google Chat API

1. Navigate to: APIs & Services → Library
2. Search for "Google Chat API"
3. Click "Enable"

### 3. Create Service Account

1. Go to: IAM & Admin → Service Accounts
2. Click "CREATE SERVICE ACCOUNT"
3. Name: `clawdbot-webhook` (or your preferred name)
4. Click "CREATE AND CONTINUE"
5. Skip optional permissions
6. Click "DONE"

### 4. Create Service Account Key

1. Find your new service account in the list
2. Click the ⋮ menu → "Manage keys"
3. Click "ADD KEY" → "Create new key"
4. Select "JSON"
5. Click "CREATE"
6. Save the downloaded JSON file to: `~/.clawdbot/credentials/google-chat.json`

### 5. Configure Google Chat Bot

Visit: https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat

Click "Configuration" and fill in:

**Bot Information:**
- **App name**: Your bot name
- **Avatar URL**: Icon URL (e.g., `https://example.com/bot-icon.png`)
- **Description**: Brief description of your bot

**Connection Settings:**

**Option A: HTTP Webhook (recommended for new bots)**
- Select "App URL"
- Enter your public webhook URL: `https://your-host.example.com/google-chat-webhook`
- Authentication audience: HTTP

**Option B: Pub/Sub (for existing bots)**
- Select "Cloud Pub/Sub"
- Topic name: `projects/your-project-id/topics/your-topic-name`

**Functionality:**
- Enable "Receive 1:1 messages"
- Enable "Join spaces and group conversations"

**Visibility:**
- Select "Make this Chat app available to specific people and groups"
- Add authorized user emails

Click "SAVE"

### 6. Set Up Public Webhook Endpoint (Webhook Mode Only)

**Option A: Tailscale Funnel**
```bash
tailscale funnel --bg --https=443 --set-path=/ http://localhost:8790
```

**Option B: ngrok**
```bash
ngrok http 8790
```

**Option C: Cloudflare Tunnel**
```bash
cloudflare tunnel --url http://localhost:8790
```

Note your public URL (e.g., `https://your-host.ts.net/google-chat-webhook`)

### 7. Configure Clawdbot

**Webhook Mode:**
```bash
clawdbot config set channels.googlechat.enabled true
clawdbot config set channels.googlechat.projectId "your-project-id"
clawdbot config set channels.googlechat.webhookMode true
clawdbot config set channels.googlechat.webhookPort 8790
clawdbot config set channels.googlechat.webhookHost "0.0.0.0"
clawdbot config set channels.googlechat.webhookPath "/google-chat-webhook"
clawdbot config set channels.googlechat.credentialsPath "$HOME/.clawdbot/credentials/google-chat.json"
clawdbot config set channels.googlechat.allowFrom '["user@example.com"]'
```

**Pub/Sub Mode:**
```bash
clawdbot config set channels.googlechat.enabled true
clawdbot config set channels.googlechat.projectId "your-project-id"
clawdbot config set channels.googlechat.subscriptionName "projects/your-project-id/subscriptions/your-subscription-name"
clawdbot config set channels.googlechat.credentialsPath "$HOME/.clawdbot/credentials/google-chat.json"
clawdbot config set channels.googlechat.allowFrom '["user@example.com"]'
```

### 8. Start Gateway

```bash
clawdbot gateway run
```

### 9. Test

1. Open Google Chat: https://chat.google.com
2. Search for your bot name
3. Send a test message
4. Bot should respond

## Configuration Reference

### Webhook Mode

```json
{
  "channels": {
    "googlechat": {
      "enabled": true,
      "projectId": "your-project-id",
      "webhookMode": true,
      "webhookPort": 8790,
      "webhookHost": "0.0.0.0",
      "webhookPath": "/google-chat-webhook",
      "credentialsPath": "/path/to/credentials.json",
      "allowFrom": ["user@example.com"]
    }
  }
}
```

### Pub/Sub Mode

```json
{
  "channels": {
    "googlechat": {
      "enabled": true,
      "projectId": "your-project-id",
      "subscriptionName": "projects/your-project-id/subscriptions/google-chat-sub",
      "credentialsPath": "/path/to/credentials.json",
      "allowFrom": ["user@example.com"]
    }
  }
}
```

## Security Policies

### DM Policy

Controls who can send direct messages:
- `"open"`: Accept DMs from anyone
- `"pairing"`: Require email in allowlist (default)
- `"disabled"`: Disable DMs

### Space Policy

Controls which spaces the bot responds in:
- `"open"`: Respond in any space
- `"allowlist"`: Only respond in allowed spaces

### Allow From

List of authorized emails:
```json
"allowFrom": [
  "user1@example.com",
  "user2@example.com"
]
```

## Monitoring

### Check Status

```bash
clawdbot channels status
```

### View Logs

```bash
# Gateway logs
tail -f /tmp/clawdbot-gateway.log

# Detailed logs
tail -f /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log
```

### Test Webhook Health (Webhook Mode)

```bash
curl https://your-host.example.com/healthz
# Should return: ok
```

## Troubleshooting

### Bot doesn't respond

1. Check webhook is accessible (webhook mode):
   ```bash
   curl https://your-host.example.com/healthz
   ```

2. Check gateway is running:
   ```bash
   clawdbot channels status
   ```

3. Check logs for errors:
   ```bash
   tail -n 100 /tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log | grep -i error
   ```

### User not authorized

Add their email to the allowFrom list in `~/.clawdbot/clawdbot.json` and restart gateway.

### Webhook timeout errors (Webhook Mode)

The webhook returns 200 immediately to prevent timeouts. Check logs to see if processing failed after the response.

## Notes

- Google Chat API no longer offers Pub/Sub for new bot creation
- HTTP webhooks are now the standard integration method
- Existing Pub/Sub bots continue to work
- Service account credentials are required for both modes (to send replies)
