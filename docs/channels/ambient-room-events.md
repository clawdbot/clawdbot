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

For always-on group chats, combine `messages.groupChat.unmentionedInbound: "room_event"` with `messages.groupChat.visibleReplies: "message_tool"`. The agent listens, decides when a reply is useful, and never needs the old prompt pattern of answering `NO_REPLY`.

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

Then make the room always-on by disabling mention gating for that room. The room must still pass its normal `groupPolicy`, room allowlist, and sender allowlist.

After saving the config, the Gateway hot-applies `messages` settings. Restart only when file watching or config reload is disabled (`gateway.reload.mode: "off"`).

## What changes

With `messages.groupChat.unmentionedInbound: "room_event"`:

- unmentioned allowed group or channel messages become quiet room events
- mentioned messages stay user requests
- text control commands and native commands stay user requests
- abort or stop requests stay user requests
- direct messages stay user requests

Room events use strict visible delivery. Final assistant text is private. The agent must call `message(action=send)` to post in the room.

Typing and lifecycle status reactions stay suppressed for room events. The one explicit receipt exception is `messages.ackReactionScope: "all"`, which sends the configured ack reaction; use any narrower scope or `"off"` when the room must remain completely silent.

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

Use per-channel Discord config when only one channel should be ambient. Under `groupPolicy: "allowlist"`, listing the channel is what allows it (`enabled: false` disables an entry):

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "<DISCORD_SERVER_ID>": {
          channels: {
            "<DISCORD_CHANNEL_ID_OR_NAME>": {
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

Slack channel allowlists are ID-first. Use channel IDs such as `C12345678`, not `#channel-name`. Listing the channel under `channels.slack.channels` is what allows it (`enabled: false` disables an entry):

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

The agent-specific `agents.entries.*.groupChat.unmentionedInbound` value overrides `messages.groupChat.unmentionedInbound` for that agent.

## Visible reply modes

`messages.groupChat.visibleReplies` defaults to `"automatic"` for normal group/channel user requests. Keep that default when final assistant text should post visibly without an explicit message-tool call.

For ambient always-on rooms, `messages.groupChat.visibleReplies: "message_tool"` is still recommended, especially with latest-generation, tool-reliable models such as GPT-5.6 Sol. It lets the agent decide when to speak by calling the message tool. If the model returns final text without calling the tool, OpenClaw keeps that final text private and logs suppressed-delivery metadata.

Room events stay strict even when other group requests use automatic replies. Unmentioned ambient room events always require `message(action=send)` for visible output.

## History

`messages.groupChat.historyLimit` sets the global group history default (50 when unset; must be a positive integer). Channels can override it with `channels.<channel>.historyLimit`, and some channels also support per-account history limits. Set the channel-level `historyLimit: 0` to disable group history context for that channel.

Supported room-event channels keep recent ambient room messages as context. Telegram keeps an always-on rolling per-group window bounded by `historyLimit`; user-request turns select entries after the bot's last recorded reply, while room-event turns receive the full recent window so the model can see its own recent posts. The retired Telegram `includeGroupHistoryContext` mode key is removed by `openclaw doctor --fix`.

## Troubleshooting

If the room shows typing or token usage but no visible message:

1. Confirm the room is allowed by the channel allowlist and sender allowlist.
2. Confirm `requireMention: false` is set at the room level you expect.
3. Check whether `messages.groupChat.unmentionedInbound` or the agent override is `"room_event"`.
4. Inspect logs for suppressed final payload metadata or `didSendViaMessagingTool: false`.
5. For normal group requests, keep or restore `messages.groupChat.visibleReplies: "automatic"` if you want final replies posted automatically. For ambient rooms using `message_tool`, use a model/runtime that reliably calls tools.

If Telegram ambient rooms do not trigger at all, check BotFather privacy mode and verify the Gateway is receiving normal group messages.

If Slack ambient rooms do not trigger, verify the channel key is the Slack channel ID and the app has the history scope for that room type: `channels:history` (public), `groups:history` (private), or `mpim:history` (multi-person DMs).

## Related

- [Groups](/channels/groups)
- [Discord](/channels/discord)
- [Slack](/channels/slack)
- [Telegram](/channels/telegram)
- [Channel troubleshooting](/channels/troubleshooting)
- [Channel configuration reference](/gateway/config-channels)
