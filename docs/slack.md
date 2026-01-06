# Slack (socket mode)

## Setup
1) Create a Slack app (From scratch) in https://api.slack.com/apps.
2) **Socket Mode** → toggle on. Then go to **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** with scope `connections:write`. Copy the **App Token** (`xapp-...`).
3) **OAuth & Permissions** → add bot token scopes (use the manifest below). Click **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-...`).
4) **Event Subscriptions** → enable events and subscribe to:
   - `message.*` (includes edits/deletes/thread broadcasts)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
5) Invite the bot to channels you want it to read.
6) Slash Commands → create the `/clawd` command (or your preferred name).
7) App Home → enable the **Messages Tab** so users can DM the bot.

Use the manifest below so scopes and events stay in sync.

## Manifest (optional)
Use this Slack app manifest to create the app quickly (adjust the name/command if you want).

```json
{
  "display_information": {
    "name": "Clawdbot",
    "description": "Slack connector for Clawdbot"
  },
  "features": {
    "bot_user": {
      "display_name": "Clawdbot",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/clawd",
        "description": "Send a message to Clawdbot",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "im:history",
        "mpim:history",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

## Config
Slack uses Socket Mode only (no HTTP webhook server). Provide both tokens:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "dm": {
      "enabled": true,
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"]
    },
    "channels": {
      "C123": {
        "enabled": true,
        "requireMention": true,
        "skills": ["customer-support"],
        "users": ["U123"],
        "systemPrompt": "You are the customer support assistant."
      },
      "#general": { "enabled": true, "autoReply": true }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "clawd",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Tokens can also be supplied via env vars:
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

## Sessions + routing
- DMs share the `main` session (like WhatsApp/Telegram).
- Channels map to `slack:channel:<channelId>` sessions.
- Slash commands use `slack:slash:<userId>` sessions.

## Delivery targets
Use these with cron/CLI sends:
- `user:<id>` for DMs
- `channel:<id>` for channels

## Tool actions
Slack tool actions can be gated with `slack.actions.*`:

| Action group | Default | Notes |
| --- | --- | --- |
| reactions | enabled | React + list reactions |
| messages | enabled | Read/send/edit/delete |
| pins | enabled | Pin/unpin/list |
| memberInfo | enabled | Member info |
| emojiList | enabled | Custom emoji list |

## Notes
- Mention gating is controlled via `slack.channels` (set `requireMention` to `true`).
- `autoReply: true` replies to every message without needing a mention.
- Per-channel skill filters live under `slack.channels.<channelId>.skills` (empty array disables skills).
- Channel topics/purposes are merged into `systemPrompt` when present.
- Use `users` in a channel config to limit who can invoke the bot.
- Channel-specific `enabled`/`allow` values override wildcard defaults.
- Reaction notifications follow `slack.reactionNotifications` (use `reactionAllowlist` with mode `allowlist`).
- Attachments are downloaded to the media store when permitted and under the size limit.
