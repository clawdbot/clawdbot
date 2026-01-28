---
title: Webex
description: Connect Moltbot to Cisco Webex for enterprise messaging
---

# Webex Integration

Connect Moltbot to [Cisco Webex](https://www.webex.com/) to enable AI-powered conversations in your enterprise messaging environment.

## Prerequisites

- A Webex account with bot creation permissions
- A publicly accessible URL for webhook delivery (your gateway URL)

## Setup

### 1. Create a Webex Bot

1. Go to the [Webex Developer Portal](https://developer.webex.com/my-apps)
2. Click **Create a New App**
3. Select **Create a Bot**
4. Fill in the bot details:
   - **Bot Name**: A display name for your bot
   - **Bot Username**: A unique identifier (e.g., `moltbot`)
   - **Icon**: Upload an avatar for your bot
   - **Description**: A brief description
5. Click **Create Bot**
6. **Important**: Copy the **Bot Access Token** - you'll need this for configuration

### 2. Configure Moltbot

Run the setup wizard:

```bash
moltbot channels setup webex
```

Or configure manually:

```yaml
channels:
  webex:
    enabled: true
    botToken: "YOUR_BOT_ACCESS_TOKEN"
    webhookSecret: "your-webhook-secret"  # Create a strong secret
    webhookPath: "/webex"  # Default webhook endpoint
```

### 3. Create a Webhook

1. Go to [Webex Webhooks](https://developer.webex.com/docs/webhooks)
2. Create a webhook with these settings:
   - **Target URL**: `https://your-gateway-url.com/webex`
   - **Resource**: `messages`
   - **Event**: `created`
   - **Secret**: Use the same `webhookSecret` from your config

You can also create webhooks programmatically:

```bash
curl -X POST https://webexapis.com/v1/webhooks \
  -H "Authorization: Bearer YOUR_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Moltbot Messages",
    "targetUrl": "https://your-gateway-url.com/webex",
    "resource": "messages",
    "event": "created",
    "secret": "your-webhook-secret"
  }'
```

### 4. Add Bot to Spaces

1. In Webex, open a space or create a new one
2. Click the **People** icon
3. Add your bot by its email address (shown after setup)
4. The bot will now receive messages in that space

## Configuration

### Full Configuration Reference

```yaml
channels:
  webex:
    enabled: true

    # Authentication
    botToken: "YOUR_BOT_ACCESS_TOKEN"     # Required

    # Webhook settings
    webhookSecret: "your-webhook-secret"  # Required for security
    webhookPath: "/webex"                 # Default: /webex
    webhookUrl: "https://..."             # Optional: explicit webhook URL

    # Bot identification (auto-detected if not set)
    botId: "Y2lz..."                      # Optional: for precise @mention detection
    botEmail: "bot@webex.bot"             # Optional: bot's email address

    # DM policy
    dm:
      policy: "pairing"                   # open, pairing, allowlist, disabled
      allowFrom:
        - "user@example.com"
        - "Y2lzY29..."  # Person ID

    # Group/room policy
    groupPolicy: "allowlist"              # open, allowlist, disabled

    # Room-specific configuration
    rooms:
      "ROOM_ID_HERE":
        allow: true
        requireMention: true              # Only respond when @mentioned
        systemPrompt: "Custom prompt for this room"
        users:                            # Optional: restrict to specific users
          - "user@example.com"
```

### DM Policies

| Policy | Description |
|--------|-------------|
| `open` | Anyone can DM the bot (use with caution) |
| `pairing` | New users must be approved before chatting |
| `allowlist` | Only users in `dm.allowFrom` can chat |
| `disabled` | No DMs allowed |

### Group Policies

| Policy | Description |
|--------|-------------|
| `open` | Bot responds in any space it's added to (mention-gated) |
| `allowlist` | Only configured rooms in `rooms` section |
| `disabled` | No group messages processed |

## Environment Variables

For the default account, you can use environment variables:

| Variable | Description |
|----------|-------------|
| `WEBEX_BOT_TOKEN` | Bot access token |
| `WEBEX_BOT_ID` | Bot's person ID |
| `WEBEX_BOT_EMAIL` | Bot's email address |

## Multi-Account Support

Run multiple Webex bots with named accounts:

```yaml
channels:
  webex:
    enabled: true
    defaultAccount: "support"
    accounts:
      support:
        name: "Support Bot"
        botToken: "TOKEN_1"
        webhookSecret: "secret1"
        webhookPath: "/webex/support"
      internal:
        name: "Internal Bot"
        botToken: "TOKEN_2"
        webhookSecret: "secret2"
        webhookPath: "/webex/internal"
```

## Status & Troubleshooting

Check connection status:

```bash
moltbot channels status --probe
```

### Common Issues

#### Bot not receiving messages

1. Verify webhook is configured correctly in Webex
2. Check that webhook secret matches your config
3. Ensure gateway is accessible from the internet
4. Check gateway logs for webhook errors

#### Authentication errors

1. Verify bot token is valid: `moltbot channels status webex --probe`
2. Regenerate token if expired (tokens don't expire but can be revoked)

#### @mention not detected

1. Ensure `botId` is configured (auto-detected on first probe)
2. In group spaces, bot typically requires @mention to respond

## API Limits

- **Message length**: 7,000 characters (markdown)
- **File attachments**: Webex handles file URLs directly
- **Rate limits**: Webex has rate limits; the plugin handles retries

## Security Notes

- **Webhook secret**: Always use a strong, random secret for webhook verification
- **Token security**: Store bot tokens securely; never commit to version control
- **DM policy**: Use `pairing` or `allowlist` in production to control access

## Links

- [Webex Developer Portal](https://developer.webex.com)
- [Webex Bot Documentation](https://developer.webex.com/docs/bots)
- [Webhooks Guide](https://developer.webex.com/docs/webhooks)
- [API Reference](https://developer.webex.com/docs/api/getting-started)
