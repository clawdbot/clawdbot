---
summary: "QQ Bot setup, config, and usage"
read_when:
  - You want to connect OpenClaw to QQ
  - You need QQ Bot credential setup
  - You want QQ Bot group or private chat support
title: QQ bot
---

QQ Bot connects to OpenClaw via the official QQ Bot API (WebSocket gateway).
C2C private chat and group `@`-mentions are the primary chat types, with rich
media (images, voice, video, files). Guild channel messages are supported for
text and remote-URL images only; voice, video, file uploads, and local/Base64
images are not available in guild channels. Reactions and threads are not
supported anywhere.

Status: official downloadable plugin.

## Install

```bash
openclaw plugins install @openclaw/qqbot
```

## Setup

1. Go to the [QQ Open Platform](https://q.qq.com/) and scan the QR code with your
   phone QQ to register / log in.
2. Click **Create Bot** to create a new QQ bot.
3. Find **AppID** and **AppSecret** on the bot's settings page and copy them.

<Note>
AppSecret is not stored in plaintext. If you leave the page without saving it, you'll have to regenerate a new one.
</Note>

4. Add the channel:

```bash
openclaw channels add --channel qqbot --token "AppID:AppSecret"
```

5. Restart the Gateway.

Interactive setup:

```bash
openclaw channels add
```

The wizard also offers QR-code binding as an alternative to typing AppID/AppSecret
manually: scan the code with the phone app tied to the target QQ Bot to complete
binding. OpenClaw persists the returned credentials under the account's config
scope.

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

Default-account env vars (top-level account only):

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

Env SecretRef AppSecret:

```json5
{
  channels: {
    qqbot: {
      enabled: true,
      appId: "YOUR_APP_ID",
      clientSecret: { source: "env", provider: "default", id: "QQBOT_CLIENT_SECRET" },
    },
  },
}
```

Notes:

- `openclaw channels add --channel qqbot --token-file ...` sets the AppSecret
  only; `appId` must already be set in config or `QQBOT_APP_ID`.
- `clientSecret` accepts a plaintext string, a file path (`clientSecretFile`),
  or a structured SecretRef object.
- Legacy `secretref:...` / `secretref-env:...` marker strings are rejected for
  `clientSecret`; use a structured SecretRef object instead.

### Access policy

- `allowFrom` / `groupAllowFrom` gate who can chat with the bot in C2C /
  group contexts. `dmPolicy` / `groupPolicy` (`open` | `allowlist` | `disabled`)
  control the enforcement mode. `dmPolicy` defaults to `allowlist` once
  `allowFrom` has a concrete (non-wildcard) entry, otherwise `open`.
  `groupPolicy` defaults to `allowlist` once either `groupAllowFrom` or
  `allowFrom` has a concrete entry, otherwise `open`.
- "Auth: allowlist" slash commands require an explicit non-wildcard entry in
  `allowFrom` (or `groupAllowFrom` for group invocations) regardless of
  `dmPolicy` / `groupPolicy` — see [Slash commands](#slash-commands).

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

Each account owns an isolated WebSocket connection, API client, and token
cache, keyed by `appId`. Log lines are tagged with the owning account id so
diagnostics stay separable when you run several bots under one Gateway.

Add a second bot via CLI:

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

### Group chats

Group support uses QQ group OpenIDs, not display names. Add the bot to a
group, then mention it or configure the group to run without a mention.

```json5
{
  channels: {
    qqbot: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["member_openid"],
      groups: {
        "*": {
          requireMention: true,
          commandLevel: "all",
          historyLimit: 50,
          tools: { deny: ["exec", "read", "write"] },
        },
        GROUP_OPENID: {
          name: "Release room",
          requireMention: false,
          ignoreOtherMentions: true,
          commandLevel: "safety",
          historyLimit: 20,
          prompt: "Keep replies short and operational.",
        },
      },
    },
  },
}
```

`groups["*"]` sets defaults for every group; a concrete `groups.GROUP_OPENID`
entry overrides those defaults for one group. Group settings:

| Field                 | Default          | Description                                                                                        |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `requireMention`      | `true`           | Require an `@`-mention before the bot replies.                                                     |
| `commandLevel`        | `all`            | Which built-in slash commands can run in the group (see below).                                    |
| `ignoreOtherMentions` | `false`          | Drop messages that mention someone else but not the bot.                                           |
| `historyLimit`        | `50`             | Recent non-mention messages kept as context for the next mentioned turn. `0` disables history.     |
| `tools`               | —                | Allow/deny tools for the whole group.                                                              |
| `toolsBySender`       | —                | Per-sender tool overrides; see [Groups](/channels/groups#groupchannel-tool-restrictions-optional). |
| `name`                | openid prefix    | Friendly label used in logs and group context.                                                     |
| `prompt`              | built-in default | Per-group behavior prompt appended to the agent context.                                           |

`commandLevel` accepts:

| Level    | Behavior                                                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`    | Existing built-in commands stay available. Some stay hidden from menus but authorized users can still run them in the group.                  |
| `safety` | `/help`, `/btw`, `/stop` stay visible in the group; sensitive commands (`/config`, `/tools`, `/bash`, etc.) must be run in private chat.      |
| `strict` | Only group-session controls needed for strict operation are allowed. `/stop` still works so an authorized sender can interrupt an active run. |

Old QQBot `toolPolicy` entries are retired. Run `openclaw doctor --fix` to migrate them to `tools`.

Activation modes are `mention` and `always`. `requireMention: true` maps to
`mention`; `requireMention: false` maps to `always`. A session-level activation
override, when present, wins over config.

The inbound queue is per peer. Group peers get a larger queue cap (50 vs. 20
for direct peers), evict bot-authored messages before human ones when full,
and merge bursts of normal group messages into one attributed turn. Slash
commands run one by one, independent of any merge batch.

### Voice (STT / TTS)

STT and TTS support two-level configuration with priority fallback:

| Setting | Plugin-specific                                          | Framework fallback            |
| ------- | -------------------------------------------------------- | ----------------------------- |
| STT     | `channels.qqbot.stt`                                     | `tools.media.audio.models[0]` |
| TTS     | `channels.qqbot.tts`, `channels.qqbot.accounts.<id>.tts` | `messages.tts`                |

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
      accounts: {
        "qq-main": {
          tts: {
            providers: {
              openai: { voice: "shimmer" },
            },
          },
        },
      },
    },
  },
}
```

Set `enabled: false` on either to disable. Account-level TTS overrides use the
same shape as `messages.tts` and deep-merge over channel/global TTS config.

STT requests time out after 60 seconds by default. Plugin-specific STT uses the
selected `models.providers.<id>.timeoutSeconds` override. Framework audio STT
uses `tools.media.audio.models[0].timeoutSeconds`, then
`tools.media.audio.timeoutSeconds`, then the selected provider override.

Inbound QQ voice attachments are exposed to agents as audio media metadata
while keeping raw voice files out of generic `MediaPaths`. `[[audio_as_voice]]`
in a plain-text reply synthesizes TTS and sends a native QQ voice message when
TTS is configured.

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

<Note>
Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B.
</Note>

## Slash commands

Built-in commands intercepted before the AI queue:

| Command              | Auth      | Scope        | Description                                                                    |
| -------------------- | --------- | ------------ | ------------------------------------------------------------------------------ |
| `/bot-ping`          | —         | any          | Latency test                                                                   |
| `/bot-help`          | —         | any          | List all commands                                                              |
| `/bot-me`            | —         | private only | Show the sender's QQ user ID (openid) for `allowFrom` / `groupAllowFrom` setup |
| `/bot-version`       | —         | private only | Show the OpenClaw framework version and plugin version                         |
| `/bot-upgrade`       | —         | private only | Show the QQBot upgrade guide link                                              |
| `/bot-approve`       | allowlist | private only | Manage command-execution approval config (on / off / always / reset / status)  |
| `/bot-logs`          | allowlist | private only | Export recent gateway logs as a file                                           |
| `/bot-clear-storage` | allowlist | private only | Delete cached downloads under the QQBot media directory                        |
| `/bot-streaming`     | allowlist | private only | Toggle C2C streaming replies                                                   |
| `/bot-group-allways` | allowlist | private only | Toggle the default group activation mode (mention-required vs. always-on)      |

Append `?` to any command for usage help (for example `/bot-upgrade ?`).

"Auth: allowlist" commands additionally require the sender's openid in an
explicit non-wildcard `allowFrom` list (`groupAllowFrom` takes precedence for
group-issued commands, falling back to `allowFrom`). A wildcard
`allowFrom: ["*"]` permits chat but not these commands. Running one of them
outside private chat, or without authorization, returns a hint rather than
silently dropping the message.

`/bot-me`, `/bot-version`, and `/bot-upgrade` are private-chat-only but do not
require the allowlist — any C2C sender can run them.

When QQ Bot exec approvals use the default same-chat fallback, native approval
button clicks follow the same explicit non-wildcard command allowlist. To
grant approval-only access without broader command access, configure
`channels.qqbot.execApprovals.approvers`. Native exec approvals are enabled by
default.

## Media and storage

- Inbound, outbound, and gateway-bridge media share one payload root under
  `~/.openclaw/media/qqbot` (honoring `OPENCLAW_HOME` when set), so uploads,
  downloads, and transcode caches stay under one guarded directory.
- Rich media delivery for C2C and group targets goes through one `sendMedia`
  path. Local files and in-memory buffers of 5&nbsp;MiB or more use QQ's
  chunked upload endpoints; smaller payloads and remote-URL/Base64 sources use
  the one-shot upload API.
- If a hot upgrade interrupts the Gateway before it finishes writing
  `openclaw.json`, the plugin restores the last-known `appId` / `clientSecret`
  for that account from an internal snapshot on the next start (never
  overwriting an intentional config change), so re-scanning the QR code is not
  required.

## Troubleshooting

- **Gateway does not start / no inbound messages:** verify `appId` and
  `clientSecret` are correct and the bot is enabled on the QQ Open Platform.
  A missing credential surfaces as "QQBot not configured (missing appId or
  clientSecret)".
- **Setup with `--token-file` still shows unconfigured:** `--token-file` only
  sets the AppSecret. `appId` must still be set in config or `QQBOT_APP_ID`.
- **Bursty group replies collide:** the inbound queue evicts bot-authored
  messages ahead of human ones when a peer's queue fills up, and merges
  bursts of normal (non-command) group messages into one attributed turn, so
  a flood of bot chatter should not starve human messages.
- **Proactive messages not arriving:** QQ may block bot-initiated messages if
  the user has not interacted recently.
- **Voice not transcribed:** ensure STT is configured and the provider is
  reachable.

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channel troubleshooting](/channels/troubleshooting)
