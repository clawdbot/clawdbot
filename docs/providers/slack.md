---
summary: "Slack socket mode setup and Clawdbot config"
read_when: "Setting up Slack or debugging Slack socket mode"
---

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
6) Slash Commands → create `/clawd` if you use `slack.slashCommand`. If you enable `commands.native`, add slash commands for the built-in chat commands (same names as `/help`).
7) App Home → enable the **Messages Tab** so users can DM the bot.

Use the manifest below so scopes and events stay in sync.

Multi-account support: use `slack.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

## History context
- `slack.historyLimit` (or `slack.accounts.*.historyLimit`) controls how many recent channel/group messages are wrapped into the prompt.
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).

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
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
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

If you enable `commands.native`, add one `slash_commands` entry per command you want to expose (matching the `/help` list).

## Scopes (current vs optional)
Slack's Conversations API is type-scoped: you only need the scopes for the
conversation types you actually touch (channels, groups, im, mpim). See
https://api.slack.com/docs/conversations-api for the overview.

### Required scopes
- `chat:write` (send/update/delete messages via `chat.postMessage`)
  https://api.slack.com/methods/chat.postMessage
- `im:write` (open DMs via `conversations.open` for user DMs)
  https://api.slack.com/methods/conversations.open
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  https://api.slack.com/methods/conversations.history
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  https://api.slack.com/methods/conversations.info
- `users:read` (user lookup)
  https://api.slack.com/methods/users.info
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  https://api.slack.com/methods/reactions.get
  https://api.slack.com/methods/reactions.add
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  https://api.slack.com/scopes/pins:read
  https://api.slack.com/scopes/pins:write
- `emoji:read` (`emoji.list`)
  https://api.slack.com/scopes/emoji:read
- `files:write` (uploads via `files.uploadV2`)
  https://api.slack.com/messaging/files/uploading

### Not needed today (but likely future)
- `mpim:write` (only if we add group-DM open/DM start via `conversations.open`)
- `groups:write` (only if we add private-channel management: create/rename/invite/archive)
- `chat:write.public` (only if we want to post to channels the bot isn't in)
  https://api.slack.com/scopes/chat:write.public
- `users:read.email` (only if we need email fields from `users.info`)
  https://api.slack.com/changelog/2017-04-narrowing-email-access
- `files:read` (only if we start listing/reading file metadata)

## Config
Slack uses Socket Mode only (no HTTP webhook server). Provide both tokens:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "open",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"]
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
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

Ack reactions are controlled globally via `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` to clear the
ack reaction after the bot replies.

## Limits
- Outbound text is chunked to `slack.textChunkLimit` (default 4000).
- Media uploads are capped by `slack.mediaMaxMb` (default 20).

## Reply threading
By default, Clawdbot replies in the main channel. Use `slack.replyToMode` to control automatic threading:

| Mode | Behavior |
| --- | --- |
| `off` | **Default.** Reply in main channel. Only thread if the triggering message was already in a thread. |
| `first` | First reply goes to thread (under the triggering message), subsequent replies go to main channel. Useful for keeping context visible while avoiding thread clutter. |
| `all` | All replies go to thread. Keeps conversations contained but may reduce visibility. |

The mode applies to both auto-replies and agent tool calls (`slack sendMessage`).

### Manual threading tags
For fine-grained control, use these tags in agent responses:
- `[[reply_to_current]]` — reply to the triggering message (start/continue thread).
- `[[reply_to:<id>]]` — reply to a specific message id.

## Sessions + routing
- DMs share the `main` session (like WhatsApp/Telegram).
- Channels map to `slack:channel:<channelId>` sessions.
- Slash commands use `slack:slash:<userId>` sessions.
- Native command registration is controlled by `commands.native`; text commands require standalone `/...` messages and can be disabled with `commands.text: false`. Slack slash commands are managed in the Slack app and are not removed automatically. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
- Full command list + config: [Slash commands](/tools/slash-commands)

## DM security (pairing)
- Default: `slack.dm.policy="pairing"` — unknown DM senders get a pairing code (expires after 1 hour).
- Approve via: `clawdbot pairing approve slack <code>`.
- To allow anyone: set `slack.dm.policy="open"` and `slack.dm.allowFrom=["*"]`.

## Group policy
- `slack.groupPolicy` controls channel handling (`open|disabled|allowlist`).
- `allowlist` requires channels to be listed in `slack.channels`.

Channel options (`slack.channels.<id>` or `slack.channels.<name>`):
- `allow`: allow/deny the channel when `groupPolicy="allowlist"`.
- `requireMention`: mention gating for the channel.
- `allowBots`: allow bot-authored messages in this channel (default: false).
- `users`: optional per-channel user allowlist.
- `skills`: skill filter (omit = all skills, empty = none).
- `systemPrompt`: extra system prompt for the channel (combined with topic/purpose).
- `enabled`: set `false` to disable the channel.

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
- Mention gating is controlled via `slack.channels` (set `requireMention` to `true`); `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) also count as mentions.
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.
- Reaction notifications follow `slack.reactionNotifications` (use `reactionAllowlist` with mode `allowlist`).
- Bot-authored messages are ignored by default; enable via `slack.allowBots` or `slack.channels.<id>.allowBots`.
- For the Slack tool, reaction removal semantics are in [/tools/reactions](/tools/reactions).
- Attachments are downloaded to the media store when permitted and under the size limit.
