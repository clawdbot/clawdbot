---
summary: "Twitch chat bot configuration and setup"
read_when:
  - Setting up Twitch chat integration for OpenClaw
title: "Twitch"
---

Twitch chat support via IRC connection. OpenClaw connects as a Twitch user (bot account) to receive and send messages in channels.

## Bundled plugin

Twitch ships as a bundled plugin in current OpenClaw releases, so normal
packaged builds do not need a separate install.

If you are on an older build or a custom install that excludes Twitch, install
it manually:

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./path/to/local/twitch-plugin
```

Details: [Plugins](/tools/plugin)

## Quick setup (beginner)

1. Ensure the Twitch plugin is available.
   - Current packaged OpenClaw releases already bundle it.
   - Older/custom installs can add it manually with the commands above.
2. Create a dedicated Twitch account for the bot (or use an existing account).
3. Generate credentials: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Select **Bot Token**
   - Verify scopes `chat:read` and `chat:write` are selected
   - Copy the **Client ID** and **Access Token**
4. Find your Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
5. Configure the token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (default account only)
   - Or config: `channels.twitch.accessToken`
   - If both are set, config takes precedence (env fallback is default-account only).
6. Start the gateway.

**⚠️ Important:** Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot. `requireMention` defaults to `true`.

Minimal config:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## What it is

- A Twitch channel owned by the Gateway.
- Deterministic routing: replies always go back to Twitch.
- Each account maps to an isolated session key `agent:<agentId>:twitch:<accountName>`.
- `username` is the bot's account (who authenticates), `channel` is which chat room to join.

## Setup (detailed)

### Generate credentials

Use [Twitch Token Generator](https://twitchtokengenerator.com/):

- Select **Bot Token**
- Verify scopes `chat:read` and `chat:write` are selected
- Copy the **Client ID** and **Access Token**

No manual app registration needed. Tokens expire after several hours.

### Configure the bot

**Env var (default account only):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Or config:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

If both env and config are set, config takes precedence.

### Access control (recommended)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.

**Available roles:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Why user IDs?** Usernames can change, allowing impersonation. User IDs are permanent.

Find your Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/) (Convert your Twitch username to ID)

## Token refresh (optional)

Tokens from [Twitch Token Generator](https://twitchtokengenerator.com/) cannot be automatically refreshed - regenerate when expired.

For automatic token refresh, create your own Twitch application at [Twitch Developer Console](https://dev.twitch.tv/console) and add to config:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

The bot automatically refreshes tokens before expiration and logs refresh events.

## Multi-account support

Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

Example (one bot account in two channels):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Note:** Each account needs its own token (one token per channel).

## Access control

### Role-based restrictions

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Allowlist by User ID (most secure)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Role-based access (alternative)

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Disable @mention requirement

By default, `requireMention` is `true`. To disable and respond to all messages:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Troubleshooting

First, run diagnostic commands:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot does not respond to messages

**Check access control:** Ensure your user ID is in `allowFrom`, or temporarily remove
`allowFrom` and set `allowedRoles: ["all"]` to test.

**Check the bot is in the channel:** The bot must join the channel specified in `channel`.

### Token issues

**"Failed to connect" or authentication errors:**

- Verify `accessToken` is the OAuth access token value (typically starts with `oauth:` prefix)
- Check token has `chat:read` and `chat:write` scopes
- If using token refresh, verify `clientSecret` and `refreshToken` are set

### Token refresh not working

**Check logs for refresh events:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

If you see "token refresh disabled (no refresh token)":

- Ensure `clientSecret` is provided
- Ensure `refreshToken` is provided

## Config

**Account config:**

- `username` - Bot username
- `accessToken` - OAuth access token with `chat:read` and `chat:write`
- `clientId` - Twitch Client ID (from Token Generator or your app)
- `channel` - Channel to join (required)
- `enabled` - Enable this account (default: `true`)
- `clientSecret` - Optional: For automatic token refresh
- `refreshToken` - Optional: For automatic token refresh
- `expiresIn` - Token expiry in seconds
- `obtainmentTimestamp` - Token obtained timestamp
- `allowFrom` - User ID allowlist
- `allowedRoles` - Role-based access control (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Require @mention (default: `true`)

**Provider options:**

- `channels.twitch.enabled` - Enable/disable channel startup
- `channels.twitch.username` - Bot username (simplified single-account config)
- `channels.twitch.accessToken` - OAuth access token (simplified single-account config)
- `channels.twitch.clientId` - Twitch Client ID (simplified single-account config)
- `channels.twitch.channel` - Channel to join (simplified single-account config)
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)

Full example:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Tool actions

The agent can call `twitch` with action:

- `send` - Send a message to a channel

Example:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Safety & ops

- **Treat tokens like passwords** - Never commit tokens to git
- **Use automatic token refresh** for long-running bots
- **Use user ID allowlists** instead of usernames for access control
- **Monitor logs** for token refresh events and connection status
- **Scope tokens minimally** - Only request `chat:read` and `chat:write`
- **If stuck**: Restart the gateway after confirming no other process owns the session

## Limits

- **500 characters** per message (auto-chunked at word boundaries)
- Markdown is stripped before chunking
- No rate limiting (uses Twitch's built-in rate limits)

## Related

- [Channels Overview](/channels) — all supported channels
- [Pairing](/channels/pairing) — DM authentication and pairing flow
- [Groups](/channels/groups) — group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) — session routing for messages
- [Security](/gateway/security) — access model and hardening
