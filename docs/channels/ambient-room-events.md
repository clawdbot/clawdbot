---
summary: "Let supported group rooms provide quiet context unless the agent sends with the message tool"
read_when:
  - Configuring always-on group or channel rooms
  - You want the agent to watch room chatter without posting final text automatically
  - Debugging typing and token usage with no visible room message
title: "Ambient room events"
sidebarTitle: "Ambient room events"
---

Ambient room events let OpenClaw process unmentioned group or channel chatter as quiet context. The agent can update memory and session state, but the room stays silent unless the agent explicitly calls the `message` tool.

For always-on group chats, this is the recommended mode: combine `messages.groupChat.unmentionedInbound: "room_event"` with `messages.groupChat.visibleReplies: "message_tool"`. Use it when the agent should listen, decide when a reply is useful, and avoid the old prompt pattern of answering `NO_REPLY`.

Supported today: Discord guild channels, Slack channels and private channels, Slack multi-person DMs, and Telegram groups or supergroups. Other group channels keep their existing group behavior unless their channel page says they support ambient room events.

## Recommended setup

Set the global group-chat behavior:

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
      visibleReplies: "message_tool",
      historyLimit: 50,
    },
  },
}
```

Then configure the room itself as always-on by disabling mention gating for that room. The channel must still be allowed by its normal `groupPolicy`, room allowlist, and sender allowlist.

After saving the config, the Gateway hot-reloads `messages` settings. Restart only when file watching or config reload is disabled.

## What changes

With `messages.groupChat.unmentionedInbound: "room_event"`:

- unmentioned allowed group or channel messages become quiet room events
- mentioned messages stay user requests
- text commands and native commands stay user requests
- abort or stop requests stay user requests
- direct messages stay user requests

Room events use strict visible delivery. Final assistant text is private. The agent must call `message(action=send)` to post in the room.

## Discord example

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
      visibleReplies: "message_tool",
      historyLimit: 50,
    },
  },
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "<DISCORD_SERVER_ID>": {
          requireMention: false,
          users: ["<YOUR_DISCORD_USER_ID>"],
        },
      },
    },
  },
}
```

Use per-channel Discord config when only one channel should be ambient:

```json5
{
  channels: {
    discord: {
      guilds: {
        "<DISCORD_SERVER_ID>": {
          channels: {
            "<DISCORD_CHANNEL_ID_OR_NAME>": {
              allow: true,
              requireMention: false,
            },
          },
        },
      },
    },
  },
}
```

## Slack example

Slack channel allowlists are ID-first. Use channel IDs such as `C12345678`, not `#channel-name`.

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
      visibleReplies: "message_tool",
      historyLimit: 50,
    },
  },
  channels: {
    slack: {
      groupPolicy: "allowlist",
      channels: {
        "<SLACK_CHANNEL_ID>": {
          allow: true,
          requireMention: false,
        },
      },
    },
  },
}
```

## Telegram example

For Telegram groups, the bot must be able to see normal group messages. If `requireMention: false`, disable BotFather privacy mode or use another Telegram setup that delivers full group traffic to the bot.

```json5
{
  messages: {
    groupChat: {
      unmentionedInbound: "room_event",
      visibleReplies: "message_tool",
      historyLimit: 50,
    },
  },
  channels: {
    telegram: {
      groups: {
        "<TELEGRAM_GROUP_CHAT_ID>": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

Telegram group IDs are usually negative numbers such as `-1001234567890`. Read `chat.id` from `openclaw logs --follow`, forward a group message to an ID helper bot, or inspect Bot API `getUpdates`.

## Agent specific policy

Use an agent override when several agents share the same room but only one should treat unmentioned chatter as ambient context:

```json5
{
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          unmentionedInbound: "room_event",
          mentionPatterns: ["@openclaw", "openclaw"],
        },
      },
    ],
  },
}
```

The agent-specific `agents.list[].groupChat.unmentionedInbound` value overrides `messages.groupChat.unmentionedInbound` for that agent.

## Visible reply modes

`messages.groupChat.visibleReplies: "message_tool"` is the recommended group and channel default. It lets the agent decide when to speak by calling the message tool. If the model returns final text without calling the tool, OpenClaw keeps that final text private and logs suppressed delivery metadata.

Use `messages.groupChat.visibleReplies: "automatic"` only when you want legacy behavior where normal group requests post final assistant text automatically.

Room events stay strict even when other group requests use automatic replies. Unmentioned ambient room events still require `message(action=send)` for visible output.

## History

`messages.groupChat.historyLimit` controls the global group history default. Channels can override it with `channels.<channel>.historyLimit`, and some channels also support per-account history limits.

Set `historyLimit: 0` to disable group history context.

Supported room-event channels keep recent ambient room messages as context. Discord keeps room-event history until a visible Discord send succeeds, so quiet context is not lost before message-tool delivery.

## Troubleshooting

If the room shows typing or token usage but no visible message:

1. Confirm the room is allowed by the channel allowlist and sender allowlist.
2. Confirm `requireMention: false` is set at the room level you expect.
3. Check whether `messages.groupChat.unmentionedInbound` or the agent override is `"room_event"`.
4. Inspect logs for suppressed final payload metadata or `didSendViaMessagingTool: false`.
5. Use a model/runtime that reliably calls tools, or set `messages.groupChat.visibleReplies: "automatic"` for legacy final replies on normal group requests.

If Telegram ambient rooms do not trigger at all, check BotFather privacy mode and verify the Gateway is receiving normal group messages.

If Slack ambient rooms do not trigger, verify the channel key is the Slack channel ID and the app has the required `channels:history` or `groups:history` scope for that room type.

## Related

- [Groups](/channels/groups)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
- [Telegram](/channels/telegram)
- [Channel troubleshooting](/channels/troubleshooting)
- [Channel configuration reference](/gateway/config-channels)
