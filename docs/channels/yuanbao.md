---
summary: "Yuanbao bot overview, features, and configuration"
read_when:
  - You want to connect a Yuanbao bot
  - You are configuring the Yuanbao channel
title: Yuanbao
---

Tencent Yuanbao is Tencent's AI assistant platform. The community-maintained `openclaw-plugin-yuanbao` plugin connects Yuanbao bots to OpenClaw over WebSocket for direct messages and group chats.

**Status:** production-ready for bot DMs and group chats. WebSocket is the only supported connection mode. This plugin is maintained by the Tencent Yuanbao team as an external catalog entry, not by core OpenClaw; the config/behavior details below (beyond install and the generic CLI surface) come from the plugin's own docs and are not verified against OpenClaw core source.

## Quick start

Requires OpenClaw 2026.4.10 or above. Check with `openclaw --version`; upgrade with `openclaw update`.

<Steps>
  <Step title="Add the Yuanbao channel with your credentials">
  ```bash
  openclaw channels add --channel yuanbao --token "appKey:appSecret"
  ```
  `--token` uses colon-separated `appKey:appSecret`. Get these from the Yuanbao app by creating a bot in your application settings.
  </Step>

  <Step title="Restart the gateway to apply the change">
  ```bash
  openclaw gateway restart
  ```
  </Step>
</Steps>

### Interactive setup (alternative)

```bash
openclaw channels login --channel yuanbao
```

Follow the prompts to enter your App ID and App Secret.

## Access control

### Direct messages

`channels.yuanbao.dm.policy`:

| Value            | Behavior                                          |
| ---------------- | ------------------------------------------------- |
| `open` (default) | Allow all users                                   |
| `pairing`        | Unknown users get a pairing code; approve via CLI |
| `allowlist`      | Only users in `allowFrom` can chat                |
| `disabled`       | Disable all DMs                                   |

Approve a pairing request:

```bash
openclaw pairing list yuanbao
openclaw pairing approve yuanbao <CODE>
```

### Group chats

`channels.yuanbao.requireMention` (default `true`): require an @mention before the bot responds in a group. Replying to the bot's own message is treated as an implicit mention.

## Configuration examples

Basic setup, open DM policy:

```json5
{
  channels: {
    yuanbao: {
      appKey: "your_app_key",
      appSecret: "your_app_secret",
      dm: {
        policy: "open",
      },
    },
  },
}
```

Restrict DMs to specific users:

```json5
{
  channels: {
    yuanbao: {
      appKey: "your_app_key",
      appSecret: "your_app_secret",
      dm: {
        policy: "allowlist",
        allowFrom: ["user_id_1", "user_id_2"],
      },
    },
  },
}
```

Disable the @mention requirement in groups:

```json5
{
  channels: {
    yuanbao: {
      requireMention: false,
    },
  },
}
```

Outbound delivery tuning:

```json5
{
  channels: {
    yuanbao: {
      outboundQueueStrategy: "merge-text",
      minChars: 2800, // buffer until this many chars
      maxChars: 3000, // force split above this limit
      idleMs: 5000, // auto-flush after idle timeout (ms)
    },
  },
}
```

Set `outboundQueueStrategy: "immediate"` to send each chunk without buffering.

## Common commands

| Command    | Description                 |
| ---------- | --------------------------- |
| `/help`    | Show available commands     |
| `/status`  | Show bot status             |
| `/new`     | Start a new session         |
| `/stop`    | Stop the current run        |
| `/restart` | Restart OpenClaw            |
| `/compact` | Compact the session context |

Yuanbao supports native slash-command menus; commands sync to the platform automatically when the gateway starts.

## Troubleshooting

**Bot does not respond in group chats:**

1. Confirm the bot is added to the group
2. Confirm you @mention the bot (required by default)
3. Check logs: `openclaw logs --follow`

**Bot does not receive messages:**

1. Confirm the bot is created and approved in the Yuanbao app
2. Confirm `appKey` and `appSecret` are correctly configured
3. Confirm the gateway is running: `openclaw gateway status`
4. Check logs: `openclaw logs --follow`

**Bot sends empty or fallback replies:**

1. Check whether the AI model is returning valid content
2. Default fallback reply: "暂时无法解答，你可以换个问题问问我哦"
3. Customize with `channels.yuanbao.fallbackReply`

**App Secret leaked:**

1. Reset the App Secret in the Yuanbao app
2. Update the value in your config
3. Restart the gateway: `openclaw gateway restart`

## Advanced configuration

### Multiple accounts

```json5
{
  channels: {
    yuanbao: {
      defaultAccount: "main",
      accounts: {
        main: {
          appKey: "key_xxx",
          appSecret: "secret_xxx",
          name: "Primary bot",
        },
        backup: {
          appKey: "key_yyy",
          appSecret: "secret_yyy",
          name: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` controls which account is used when outbound APIs do not specify an `accountId`.

### Message limits

- `maxChars`: single message max character count (default `3000`)
- `mediaMaxMb`: media upload/download limit (default `20` MB)
- `overflowPolicy`: behavior when a message exceeds the limit, `"split"` (default) or `"stop"`

### Streaming

Yuanbao supports block-level streaming output; the bot sends text in chunks as it generates.

```json5
{
  channels: {
    yuanbao: {
      disableBlockStreaming: false, // block streaming enabled (default)
    },
  },
}
```

Set `disableBlockStreaming: true` to send the complete reply in one message.

### Group chat history context

```json5
{
  channels: {
    yuanbao: {
      historyLimit: 100, // default: 100, set 0 to disable
    },
  },
}
```

Controls how many historical messages are included in the AI context for group chats.

### Reply-to mode

```json5
{
  channels: {
    yuanbao: {
      replyToMode: "first", // "off" | "first" | "all" (default: "first")
    },
  },
}
```

| Value   | Behavior                                                 |
| ------- | -------------------------------------------------------- |
| `off`   | No quote reply                                           |
| `first` | Quote only the first reply per inbound message (default) |
| `all`   | Quote every reply                                        |

### Markdown hint injection

By default, the bot injects a system-prompt instruction to prevent the model from wrapping the entire reply in a markdown code block.

```json5
{
  channels: {
    yuanbao: {
      markdownHintEnabled: true, // default: true
    },
  },
}
```

### Debug mode

```json5
{
  channels: {
    yuanbao: {
      debugBotIds: ["bot_user_id_1", "bot_user_id_2"],
    },
  },
}
```

Enables unsanitized log output for the listed bot IDs.

### Multi-agent routing

Use `bindings` to route Yuanbao DMs or groups to different agents:

```json5
{
  agents: {
    list: [
      { id: "main" },
      { id: "agent-a", workspace: "/home/user/agent-a" },
      { id: "agent-b", workspace: "/home/user/agent-b" },
    ],
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "yuanbao",
        peer: { kind: "direct", id: "user_xxx" },
      },
    },
    {
      agentId: "agent-b",
      match: {
        channel: "yuanbao",
        peer: { kind: "group", id: "group_zzz" },
      },
    },
  ],
}
```

- `match.channel`: `"yuanbao"`
- `match.peer.kind`: `"direct"` (DM) or `"group"` (group chat)
- `match.peer.id`: user ID or group code

## Configuration reference

Full configuration: [Gateway configuration](/gateway/configuration)

| Setting                                    | Description                                       | Default                                |
| ------------------------------------------ | ------------------------------------------------- | -------------------------------------- |
| `channels.yuanbao.enabled`                 | Enable/disable the channel                        | `true`                                 |
| `channels.yuanbao.defaultAccount`          | Default account for outbound routing              | `default`                              |
| `channels.yuanbao.accounts.<id>.appKey`    | App Key (signing + ticket generation)             | -                                      |
| `channels.yuanbao.accounts.<id>.appSecret` | App Secret (signing)                              | -                                      |
| `channels.yuanbao.accounts.<id>.token`     | Pre-signed token (skips automatic ticket signing) | -                                      |
| `channels.yuanbao.accounts.<id>.name`      | Account display name                              | -                                      |
| `channels.yuanbao.accounts.<id>.enabled`   | Enable/disable a specific account                 | `true`                                 |
| `channels.yuanbao.dm.policy`               | DM policy                                         | `open`                                 |
| `channels.yuanbao.dm.allowFrom`            | DM allowlist (user ID list)                       | -                                      |
| `channels.yuanbao.requireMention`          | Require @mention in groups                        | `true`                                 |
| `channels.yuanbao.overflowPolicy`          | Long message handling (`split` or `stop`)         | `split`                                |
| `channels.yuanbao.replyToMode`             | Group reply-to strategy (`off`, `first`, `all`)   | `first`                                |
| `channels.yuanbao.outboundQueueStrategy`   | Outbound strategy (`merge-text` or `immediate`)   | `merge-text`                           |
| `channels.yuanbao.minChars`                | Merge-text: min chars to trigger send             | `2800`                                 |
| `channels.yuanbao.maxChars`                | Merge-text: max chars per message                 | `3000`                                 |
| `channels.yuanbao.idleMs`                  | Merge-text: idle timeout before auto-flush (ms)   | `5000`                                 |
| `channels.yuanbao.mediaMaxMb`              | Media size limit (MB)                             | `20`                                   |
| `channels.yuanbao.historyLimit`            | Group chat history context entries                | `100`                                  |
| `channels.yuanbao.disableBlockStreaming`   | Disable block-level streaming output              | `false`                                |
| `channels.yuanbao.fallbackReply`           | Fallback reply when the model returns no content  | `暂时无法解答，你可以换个问题问问我哦` |
| `channels.yuanbao.markdownHintEnabled`     | Inject markdown anti-wrapping instructions        | `true`                                 |
| `channels.yuanbao.debugBotIds`             | Debug allowlist bot IDs (unsanitized logs)        | `[]`                                   |

## Supported message types

**Receive:** text, images, files, audio/voice, video, stickers/custom emoji, custom elements (link cards).

**Send:** text (markdown), images, files, audio, video, stickers.

**Threads and replies:** quote replies (configurable via `replyToMode`); thread replies are not supported by the platform.

## Related

- [Channels Overview](/channels) - all supported channels
- [Pairing](/channels/pairing) - DM authentication and pairing flow
- [Groups](/channels/groups) - group chat behavior and mention gating
- [Channel Routing](/channels/channel-routing) - session routing for messages
- [Security](/gateway/security) - access model and hardening
