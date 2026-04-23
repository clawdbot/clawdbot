---
summary: "QQ Bot setup, config, and usage"
read_when:
  - You want to connect OpenClaw to QQ
  - You need QQ Bot credential setup
  - You want QQ Bot group or private chat support
title: QQ bot
---

QQ Bot connects to OpenClaw via the official QQ Bot API (WebSocket gateway). The
plugin supports C2C private chat, group @messages, and guild channel messages with
rich media (images, voice, video, files).

Status: bundled plugin. Direct messages, group chats, guild channels, and
media are supported. Reactions and threads are not supported.

## Bundled plugin

Current OpenClaw releases bundle QQ Bot, so normal packaged builds do not need
a separate `openclaw plugins install` step.

## Setup

1. Go to the [QQ Open Platform](https://q.qq.com/) and scan the QR code with your
   phone QQ to register / log in.
2. Click **Create Bot** to create a new QQ bot.
3. Find **AppID** and **AppSecret** on the bot's settings page and copy them.

> AppSecret is not stored in plaintext — if you leave the page without saving it,
> you'll have to regenerate a new one.

4. Add the channel:

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

5. Restart the Gateway.

Interactive setup paths:

```bash
openclaw channels add
openclaw configure --section channels
```

## Configure

Minimal config:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecret: "YOUR_APP_SECRET",
    },
  },
}
```

Default-account env vars:

- `QQBOT_APP_ID`
- `QQBOT_CLIENT_SECRET`

File-backed AppSecret:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecretFile: "/path/to/qqbot-secret.txt",
    },
  },
}
```

Notes:

- Env fallback applies to the default QQ Bot account only.
- `openclaw channels add --channel qqbot --token-file ...` provides the
  AppSecret only; the AppID must already be set in config or `QQBOT_APP_ID`.
- `clientSecret` also accepts SecretRef input, not just a plaintext string.

### Multi-account setup

Run multiple QQ bots under a single OpenClaw instance:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "111111111",
      clientSecret: "secret-of-bot-1",
      accounts: {
        bot2: {
          enabled: true,
          appId: "222222222",
          clientSecret: "secret-of-bot-2",
        },
      },
    },
  },
}
```

Each account launches its own WebSocket connection and maintains an independent
token cache (isolated by `appId`).

Add a second bot via CLI:

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

### Voice (STT / TTS)

STT and TTS support two-level configuration with priority fallback:

| Setting | Plugin-specific      | Framework fallback            |
| ------- | -------------------- | ----------------------------- |
| STT     | `channels.qqbot.stt` | `tools.media.audio.models[0]` |
| TTS     | `channels.qqbot.tts` | `messages.tts`                |

```json5
{
  channels: {
    qqbot: {
      stt: {
        provider: "your-provider",
        model: "your-stt-model",
      },
      tts: {
        provider: "your-provider",
        model: "your-tts-model",
        voice: "your-voice",
      },
    },
  },
}
```

Set `enabled: false` on either to disable.

Outbound audio upload/transcode behavior can also be tuned with
`channels.qqbot.audioFormatPolicy`:

- `sttDirectFormats`
- `uploadDirectFormats`
- `transcodeEnabled`

## Target formats

| Format                     | Description        |
| -------------------------- | ------------------ |
| `qqbot:c2c:OPENID`         | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat         |
| `qqbot:channel:CHANNEL_ID` | Guild channel      |

> Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot**
> be used to send messages via Bot B.

## Slash commands

Built-in commands intercepted before the AI queue:

| Command        | Description                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `/bot-ping`    | Latency test                                                                                             |
| `/bot-version` | Show the OpenClaw framework version                                                                      |
| `/bot-help`    | List all commands                                                                                        |
| `/bot-upgrade` | Show the QQBot upgrade guide link                                                                        |
| `/bot-logs`    | Export recent gateway logs as a file                                                                     |
| `/bot-approve` | Approve a pending QQ Bot action (for example, confirming a C2C or group upload) through the native flow. |

Append `?` to any command for usage help (for example `/bot-upgrade ?`).

## Engine architecture

QQ Bot ships as a self-contained engine inside the plugin:

- Each account owns an isolated resource stack (WebSocket connection, API client, token cache, media storage root) keyed by `appId`. Accounts never share inbound/outbound state.
- The multi-account logger tags log lines with the owning account so diagnostics stay separable when you run several bots under one gateway.
- Inbound, outbound, and gateway bridge paths share a single media payload root under `~/.openclaw/media`, so uploads, downloads, and transcode caches land under one guarded directory instead of a per-subsystem tree.
- Credentials can be backed up and restored as part of standard OpenClaw credential snapshots; the engine re-attaches each account's resource stack on restore without requiring a fresh QR-code pair.

## QR-code onboarding

As an alternative to pasting `AppID:AppSecret` manually, the engine supports a QR-code onboarding flow for linking a QQ Bot to OpenClaw:

1. Run the QQ Bot setup path (for example `openclaw channels add --channel qqbot`) and pick the QR-code flow when prompted.
2. Scan the generated QR code with the phone app tied to the target QQ Bot.
3. Approve the pairing on the phone. OpenClaw persists the returned credentials into `credentials/` under the right account scope.

Approval prompts generated by the bot itself (for example, "allow this action?" flows exposed by the QQ Bot API) surface as native OpenClaw prompts that you can accept with `/bot-approve` rather than replying through the raw QQ client.

## Troubleshooting

- **Bot replies "gone to Mars":** credentials not configured or Gateway not started.
- **No inbound messages:** verify `appId` and `clientSecret` are correct, and the
  bot is enabled on the QQ Open Platform.
- **Setup with `--token-file` still shows unconfigured:** `--token-file` only sets
  the AppSecret. You still need `appId` in config or `QQBOT_APP_ID`.
- **Proactive messages not arriving:** QQ may intercept bot-initiated messages if
  the user hasn't interacted recently.
- **Voice not transcribed:** ensure STT is configured and the provider is reachable.
