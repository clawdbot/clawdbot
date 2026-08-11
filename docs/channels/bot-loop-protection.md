---
summary: "Bot-to-bot loop protection defaults and channel overrides"
read_when:
  - Configuring bot-authored channel messages
  - Tuning bot-to-bot loop protection
title: "Bot loop protection"
sidebarTitle: "Bot loop protection"
---

OpenClaw can accept messages written by other bots on channels that support `allowBots`. When that path is enabled, pair loop protection prevents two bot identities from replying to each other indefinitely.

The guard is enforced by the core inbound reply runner. Each supporting channel maps its inbound event into generic facts: account or scope, conversation id, sender bot id, and receiver bot id. Core tracks the participant pair in both directions (A to B and B to A count as the same pair), applies a sliding-window budget, and suppresses the pair during a cooldown after the budget is exceeded.

## Defaults

Pair loop protection is active whenever a channel lets bot-authored messages reach dispatch. Built-in defaults:

| Key                  | Default | Meaning                                             |
| -------------------- | ------- | --------------------------------------------------- |
| `enabled`            | `true`  | Guard active for channels that support it.          |
| `maxEventsPerWindow` | `20`    | Events a bot pair can exchange within the window.   |
| `windowSeconds`      | `60`    | Sliding window length.                              |
| `cooldownSeconds`    | `60`    | Suppression time after the pair exceeds the budget. |

The guard does not affect human-authored messages, single-bot deployments, self-message filtering, or bot replies that stay under the budget.

## Configure shared defaults

Set `channels.defaults.botLoopProtection` once to give every supporting channel the same baseline. Channels may also expose narrower overrides; Feishu intentionally uses only this shared baseline.

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

Set `enabled: false` only when your channel policy intentionally allows bot-to-bot conversations without automatic suppression.

## Override per channel, account, or room

Supporting channels layer their own config over the shared default, key by key. Precedence, narrowest first:

1. `channels.<channel>.<room-or-space>.botLoopProtection`, when the channel supports per-conversation overrides
2. `channels.<channel>.accounts.<account>.botLoopProtection`, when the channel supports accounts
3. `channels.<channel>.botLoopProtection`, when the channel supports top-level defaults
4. `channels.defaults.botLoopProtection`
5. built-in defaults

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
        secondary: {
          allowBots: true,
          botLoopProtection: {
            maxEventsPerWindow: 5,
            cooldownSeconds: 90,
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
    slack: {
      allowBots: "mentions",
      botLoopProtection: {
        maxEventsPerWindow: 8,
      },
    },
  },
}
```

## Channel support

- Discord: native `author.bot` facts, keyed by Discord account, channel, and bot pair.
- Feishu: native `sender_type=bot` facts for admitted bot-authored group messages, keyed by Feishu account, chat, and bot pair. Feishu uses only `channels.defaults.botLoopProtection`.
- Google Chat: native `sender.type=BOT` facts for accepted bot-authored messages, keyed by account, space, and bot pair.
- Matrix: configured Matrix bot accounts, keyed by Matrix account, room, and configured bot pair.
- Slack: native `bot_id` facts for accepted bot-authored messages, keyed by Slack account, channel, and bot pair.

Channels that do not expose a reliable inbound bot identity keep using their normal self-message and access-policy filters. They should not opt into this guard until they can identify both participants in the bot pair.

See [SDK runtime](/plugins/sdk-runtime#reusable-runtime-utilities) for plugin implementation details.
