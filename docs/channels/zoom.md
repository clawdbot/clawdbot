---
summary: "Zoom Team Chat plugin support status, capabilities, and configuration"
read_when:
  - Working on Zoom Team Chat integration
  - Setting up Zoom bot webhooks
---
# Zoom Team Chat

Status: production-ready plugin for Zoom Team Chat direct messages via Team Chat Bot API and webhooks.

## Quick setup

1) Create a 'General App' in [Zoom App Marketplace](https://marketplace.zoom.us/develop/create)
2) Production tab: Add OAuth Redirect URL (`https://gateway-host/api/zoomapp/auth`)
3) Features tab → Surfaces → Team Chat: Toggle on Team Chat Subscription, add Bot endpoint URL (`https://gateway-host/webhooks/zoom`) and Welcome Message
4) Note your credentials: Client ID, Client Secret, Bot JID, Secret Token
5) Install the plugin: `pnpm install` (the zoom extension is included in the workspace)
6) Set credentials in config:
   ```json5
   {
     channels: {
       zoom: {
         enabled: true,
         clientId: "YOUR_CLIENT_ID",
         clientSecret: "YOUR_CLIENT_SECRET",
         botJid: "YOUR_BOT_JID@xmpp.zoom.us",
         secretToken: "YOUR_SECRET_TOKEN",
         redirectUri: "https://yourdomain.com/api/zoomapp/auth",
         dm: { policy: "open" }
       }
     }
   }
   ```
6) Start the gateway
7) Message the bot in Zoom Team Chat

## What it is

- A Zoom Team Chat channel plugin that receives messages via webhooks
- Direct message support (groups not currently supported)
- Webhook server runs on port 3001 (Gateway Control UI uses 3000)
- OAuth 2.0 client credentials flow for API authentication

## Setup (detailed)

### 1. Create Zoom App

1) Go to [Zoom App Marketplace](https://marketplace.zoom.us/develop/create)
2) Click "Create" and select "**General App**"
3) Fill in basic app information (name, description, etc.)
4) Go to the **Production** tab:
   - Add **OAuth Redirect URL**: `https://gateway-host/api/zoomapp/auth`
5) Go to the **Features** tab:
   - Under **Surfaces**, select "**Team Chat**"
   - Toggle on "**Team Chat Subscription**"
   - Add **Bot endpoint URL**: `https://gateway-host/webhooks/zoom`
   - Set **Welcome Message** for the bot (e.g., "Hello! I'm your AI assistant.")
6) Note your credentials from the app settings:
   - **Client ID** (from App Credentials)
   - **Client Secret** (from App Credentials)
   - **Bot JID** (from Team Chat section, e.g., `bot@xmppdev.zoom.us`)
   - **Secret Token** (from Team Chat section, for webhook verification)

### 2. Configure URLs

Configure these URLs in your Zoom app settings:

**Webhook URL** (for receiving messages):
```
https://gateway-host/webhooks/zoom
```

**OAuth Redirect URL** (for app installation):
```
https://gateway-host/api/zoomapp/auth
```

Replace `gateway-host` with:
- **Local development**: Use ngrok (`ngrok http 3001`) or another tunnel service to expose port 3001
- **Production**: Your server's public domain (configure reverse proxy to forward to port 3001)

Subscribe to these event types:
- `bot_notification` - Required for receiving messages

**Important**: The `redirectUri` in your Moltbot config must EXACTLY match the OAuth Redirect URL configured in your Zoom app. OAuth will fail if these don't match.

Examples:
- Local dev: `https://abc123.ngrok.io/api/zoomapp/auth`
- Production: `https://yourdomain.com/api/zoomapp/auth`

### 3. Install App to Your Account

1) In app settings, click "Install"
2) Authorize the app
3) The bot will appear in your Zoom Team Chat

### 4. Configure Moltbot

Add to `~/.clawdbot/moltbot.json`:

**Production (default):**
```json5
{
  channels: {
    zoom: {
      enabled: true,
      clientId: "YOUR_CLIENT_ID",
      clientSecret: "YOUR_CLIENT_SECRET",
      botJid: "YOUR_BOT_JID@xmpp.zoom.us",
      secretToken: "YOUR_SECRET_TOKEN",
      redirectUri: "https://yourdomain.com/api/zoomapp/auth",  // Must match Zoom app OAuth Redirect URL
      dm: {
        policy: "open"                        // open | allowlist | pairing
      }
    }
  }
}
```

**Development (optional explicit config):**
```json5
{
  channels: {
    zoom: {
      enabled: true,
      clientId: "YOUR_CLIENT_ID",
      clientSecret: "YOUR_CLIENT_SECRET",
      botJid: "YOUR_BOT_JID@xmppdev.zoom.us",
      secretToken: "YOUR_SECRET_TOKEN",
      redirectUri: "https://abc123.ngrok.io/api/zoomapp/auth",
      apiHost: "https://zoomdev.us",
      oauthHost: "https://zoomdev.us",
      dm: {
        policy: "open"
      }
    }
  }
}
```

### 5. Start Gateway

```bash
moltbot gateway run
```

The webhook server will start on port 3001.

### 6. Test

Send a direct message to your bot in Zoom Team Chat. The bot should respond with context-aware replies.

## Configuration Options

### DM Policies

**Open** (default):
```json5
{
  channels: {
    zoom: {
      dm: {
        policy: "open"
      }
    }
  }
}
```
Anyone can message the bot.

**Closed**:
```json5
{
  channels: {
    zoom: {
      dm: {
        policy: "closed"
      }
    }
  }
}
```
Bot rejects all DMs.

**Allowlist**:
```json5
{
  channels: {
    zoom: {
      dm: {
        policy: "allowlist",
        allowFrom: [
          "user1@xmpp.zoom.us",
          "user2@xmpp.zoom.us"
        ]
      }
    }
  }
}
```
Only specified users can message the bot.

### Development vs Production

**Production (default):**
```json5
{
  channels: {
    zoom: {
      botJid: "bot@xmpp.zoom.us"
      // apiHost and oauthHost default to production URLs
      // apiHost: "https://api.zoom.us"
      // oauthHost: "https://zoom.us"
    }
  }
}
```

**Development:**
```json5
{
  channels: {
    zoom: {
      apiHost: "https://zoomdev.us",
      oauthHost: "https://zoomdev.us",
      botJid: "bot@xmppdev.zoom.us"
    }
  }
}
```

## Features

- **Direct Messages**: One-on-one conversations
- **Conversation History**: Full context retention across messages
- **Streaming Responses**: Real-time message updates
- **Tool Execution**: All standard Moltbot tools are available
- **Session Management**: Persistent sessions per user

## Session Keys

Session keys follow the format:
```
zoom:default:user@xmppdev.zoom.us
```

Sessions are stored at:
```
~/.moltbot/agents/{agentId}/sessions/{session-id}.jsonl
```

## Capabilities

- **Chat types**: Direct messages only (groups not supported)
- **Reactions**: Not supported
- **Threads**: Not supported
- **Media**: Not currently supported
- **Streaming**: Supported (coalesced with 1500 char minimum, 1000ms idle)

## Troubleshooting

### Port 3000 Conflict

If you see "port 3000 already in use":
- Gateway Control UI runs on port 3000
- Zoom webhook server uses port 3001
- This is expected and correct

### Webhook Not Receiving Messages

1. Check tunnel is running (if using FRP or similar)
2. Verify webhook URL in Zoom app settings matches your tunnel/domain
3. Check gateway logs for errors
4. Verify `secretToken` matches your app configuration

### Bot Not Responding

1. Verify credentials in `~/.clawdbot/moltbot.json` are correct
2. Check LLM provider API key is configured (see `moltbot login`)
3. Ensure `botJid` matches your app's Bot JID exactly
4. Confirm app is installed to your Zoom account
5. Check gateway logs for authentication errors

### OAuth Issues

If you see authentication errors:
- Verify `clientId` and `clientSecret` are correct
- Check `oauthHost` matches your environment (dev vs prod)
- Review gateway logs for OAuth token errors

## Architecture

The Zoom plugin follows Moltbot's standard channel plugin architecture:

- **Extension**: `extensions/zoom/` - Plugin registration and metadata
- **Core**: `src/zoom/` - Webhook server, message handling, API client
- **Monitor**: Starts Express server on port 3001, handles webhook events
- **Message Handler**: Integrates with `dispatchInboundMessage()` for AI routing

For implementation details, see the [plugin source code](https://github.com/moltbot/moltbot/tree/main/extensions/zoom).

## Security

**Never commit credentials!**

Store sensitive values in `~/.clawdbot/moltbot.json` (user's home directory, not in repo).

Webhook events are verified using the `secretToken` from your Zoom app configuration.

## Limitations

- Groups are not currently supported
- Media uploads not yet implemented
- Reactions not supported
- Thread support not available

## See Also

- [Channels Overview](/channels)
- [Gateway Configuration](/gateway/configuration)
- [Security Policies](/gateway/security)
- [Zoom App Marketplace](https://marketplace.zoom.us/)
