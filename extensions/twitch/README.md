# @clawdbot/twitch

Twitch channel plugin for Clawdbot.

## Install (local checkout)

```bash
clawdbot plugins install ./extensions/twitch
```

## Install (npm)

```bash
clawdbot plugins install @clawdbot/twitch
```

Onboarding: select Twitch and confirm the install prompt to fetch the plugin automatically.

## Config

Minimal config (simplified single-account):

**⚠️ Important:** `requireMention` defaults to `true`. Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot.

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "clawdbot",
      accessToken: "oauth:abc123...", // OAuth Access Token (add oauth: prefix)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Channel to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only (Convert your twitch username to ID at https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)
    },
  },
}
```

**Access control options:**

- `requireMention: false` - Disable the default mention requirement to respond to all messages
- `allowFrom: ["your_user_id"]` - Restrict to your Twitch user ID only (find your ID at https://www.twitchangles.com/xqc or similar)
- `allowedRoles: ["moderator", "vip", "subscriber"]` - Restrict to specific roles

Multi-account config (advanced):

```json5
{
  channels: {
    twitch: {
      enabled: true,
      accounts: {
        default: {
          username: "clawdbot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "clawdbot",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

## Setup

1. Create a dedicated Twitch account for the bot, then generate credentials: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Select **Bot Token**
   - Verify scopes `chat:read` and `chat:write` are selected
   - Copy the **Access Token** to `token` property
   - Copy the **Client ID** to `clientId` property
2. Start the gateway

## Full documentation

See https://docs.molt.bot/channels/twitch for:

- Token refresh setup
- Access control patterns
- Multi-account configuration
- Troubleshooting
- Capabilities & limits
