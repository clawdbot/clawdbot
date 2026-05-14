---
summary: "Bot-to-bot loop protection defaults and channel overrides"
read_when:
  - Configuring bot-authored channel messages
  - Tuning bot-to-bot loop protection
title: "Bot loop protection"
sidebarTitle: "Bot loop protection"
---

# Bot loop protection

OpenClaw can accept messages written by other bots on channels that support `allowBots`.
When that path is enabled, pair loop protection prevents two bot identities from
replying to each other indefinitely.

The guard is enforced by the core channel-turn kernel. Each supporting channel
maps its own inbound event into generic facts: account or scope, conversation id,
sender bot id, and receiver bot id. Core then tracks the participant pair in both
directions, applies a sliding-window budget, and suppresses the pair during a
cooldown after the budget is exceeded.

## Defaults

Pair loop protection is active when a channel lets bot-authored messages reach
dispatch. Built-in defaults are:

- `maxEventsPerWindow: 20` - a bot pair can exchange 20 events within the window
- `windowSeconds: 60` - sliding window length
- `cooldownSeconds: 60` - suppression time after the pair exceeds the budget

The guard does not affect normal human-authored messages, single-bot deployments,
self-message filtering, or one-shot bot replies that stay under the budget.

## Configure shared defaults

Set `channels.defaults.botLoopProtection` once to give every supporting channel
the same baseline. Channel and account overrides can still tune individual
surfaces.

```json5
{
  channels: {
    defaults: {
      botLoopProtection: {
        maxEventsPerWindow: 20,
        windowSeconds: 60,
        cooldownSeconds: 60,
      },
    },
  },
}
```

Set `enabled: false` only when your channel policy intentionally allows
bot-to-bot conversations without automatic suppression.

## Override per channel or account

Supporting channels layer their own config over the shared default. Precedence is:

- `channels.<channel>.<room-or-space>.botLoopProtection`, when the channel supports per-conversation overrides
- `channels.<channel>.accounts.<account>.botLoopProtection`, when the channel supports accounts
- `channels.<channel>.botLoopProtection`, when the channel supports top-level defaults
- `channels.defaults.botLoopProtection`
- built-in defaults

```json5
{
  channels: {
    defaults: {
      botLoopProtection: {
        maxEventsPerWindow: 20,
      },
    },
    discord: {
      botLoopProtection: {
        maxEventsPerWindow: 8,
      },
      accounts: {
        molty: {
          allowBots: "mentions",
          botLoopProtection: {
            maxEventsPerWindow: 5,
            cooldownSeconds: 90,
          },
        },
      },
    },
    slack: {
      allowBots: "mentions",
      botLoopProtection: {
        maxEventsPerWindow: 8,
      },
    },
    matrix: {
      allowBots: "mentions",
      groups: {
        "!roomid:example.org": {
          botLoopProtection: {
            maxEventsPerWindow: 5,
          },
        },
      },
    },
    googlechat: {
      allowBots: true,
      groups: {
        "spaces/AAAA": {
          botLoopProtection: {
            maxEventsPerWindow: 5,
          },
        },
      },
    },
  },
}
```

## Channel support

- Discord: native `author.bot` facts, keyed by Discord account, channel, and bot pair.
- Slack: native `bot_id` facts for accepted bot-authored messages, keyed by Slack account, channel, and bot pair.
- Matrix: configured Matrix bot accounts, keyed by Matrix account, room, and configured bot pair.
- Google Chat: native `sender.type=BOT` facts for accepted bot-authored messages, keyed by account, space, and bot pair.

Channels that do not expose a reliable inbound bot identity keep using their
normal self-message and access-policy filters. They should not opt into this
guard until they can identify both participants in the bot pair.

See [SDK runtime](/plugins/sdk-runtime#reusable-runtime-utilities) for plugin
implementation details.
