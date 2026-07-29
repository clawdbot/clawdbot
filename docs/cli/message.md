---
summary: "CLI reference for `openclaw message` (send + channel actions)"
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound channel behavior
title: "Message"
---

# `openclaw message`

Single outbound command for sending messages and channel actions across
Discord, Google Chat, iMessage, Matrix, Mattermost (plugin), Microsoft Teams,
Signal, Slack, Telegram, and WhatsApp.

```bash
openclaw message <subcommand> [flags]
```

## Channel selection

- `--channel <name>` is required if more than one channel is configured; with
  exactly one channel configured, that channel is the default.
- Values: `discord|googlechat|imessage|matrix|mattermost|msteams|signal|slack|telegram|whatsapp`
  (Mattermost requires the plugin).
- Channel-prefixed targets (for example `discord:channel:123`) resolve the
  owning plugin without an explicit `--channel`.

## Target formats (`-t, --target`)

| Channel             | Format                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Discord             | `channel:<id>`, `user:<id>`, `<@id>` mention, or a bare numeric id (treated as a channel id)               |
| Google Chat         | `spaces/<spaceId>` or `users/<userId>`                                                                     |
| iMessage            | handle, `chat_id:<id>`, `chat_guid:<guid>`, or `chat_identifier:<id>`                                      |
| Mattermost (plugin) | `channel:<id>`, `user:<id>`, `@username`, or a bare id (treated as a channel)                              |
| Matrix              | `@user:server`, `!room:server`, or `#alias:server`                                                         |
| Microsoft Teams     | `conversation:<id>` (`19:...@thread.tacv2`), a bare conversation id, or `user:<aad-object-id>`             |
| Signal              | `+E.164`, `group:<id>`, `uuid:<id>`, `username:<name>`/`u:<name>`, or any of these prefixed with `signal:` |
| Slack               | `channel:<id>` or `user:<id>` (a bare id is treated as a channel)                                          |
| Telegram            | chat id, `@username`, or a forum topic target: `<chatId>:topic:<topicId>` (or `--thread-id <topicId>`)     |
| WhatsApp            | E.164, group JID (`...@g.us`), or Channel/Newsletter JID (`...@newsletter`)                                |

Channel name lookup: for providers with a directory (Discord/Slack/etc), names
like `Help` or `#help` resolve via the directory cache, falling back to a live
directory lookup on a cache miss where the provider supports it.

## Common flags

Every action accepts: `--channel <name>`, `--account <id>`, `--json`,
`--dry-run`, `--verbose`. Actions that take a destination also accept
`-t, --target <dest>`.

## SecretRef resolution

`openclaw message` resolves channel SecretRefs before running the action,
scoped as narrowly as possible:

- channel-scoped when `--channel` is set (or inferred from a prefixed target)
- account-scoped when `--account` is also set
- all configured channels when neither is set

Unresolved SecretRefs on unrelated channels never block a targeted action; an
unresolved SecretRef on the selected channel/account fails the action closed.

## Actions

### Core

| Action          | Channels                                                                                                        | Required                                                       | Notes                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send`          | Discord, Google Chat, iMessage, Matrix, Mattermost (plugin), Microsoft Teams, Signal, Slack, Telegram, WhatsApp | `--target`, plus one of `--message`/`--media`/`--presentation` | See [Send](#send) below.                                                                                                                                                                                                                                                                               |
| `poll`          | Discord, Matrix, Microsoft Teams, Telegram, WhatsApp                                                            | `--target`, `--poll-question`, `--poll-option` (repeat)        | See [Poll](#poll) below.                                                                                                                                                                                                                                                                               |
| `react`         | Discord, Matrix, Nextcloud Talk, Signal, Slack, Telegram, WhatsApp                                              | `--message-id`, `--target`                                     | `--emoji`, `--remove` (needs `--emoji`; omit it to clear own reactions where supported, see [Reactions](/tools/reactions)). WhatsApp: `--participant`, `--from-me`. Signal group reactions require `--target-author` or `--target-author-uuid`. Nextcloud Talk only adds reactions; `--remove` errors. |
| `reactions`     | Discord, Matrix, Microsoft Teams, Slack                                                                         | `--message-id`, `--target`                                     | `--limit`.                                                                                                                                                                                                                                                                                             |
| `read`          | Discord, Matrix, Microsoft Teams, Slack                                                                         | `--target`                                                     | `--limit`, `--message-id`, `--before`, `--after`. Discord: `--around`, `--include-thread`. Slack: `--message-id` reads a specific timestamp, combine with `--thread-id` for an exact thread reply.                                                                                                     |
| `edit`          | Discord, Matrix, Microsoft Teams, Slack, Telegram                                                               | `--message-id`, `--message`, `--target`                        | Telegram forum threads use `--thread-id`.                                                                                                                                                                                                                                                              |
| `delete`        | Discord, Matrix, Microsoft Teams, Slack, Telegram                                                               | `--message-id`, `--target`                                     |                                                                                                                                                                                                                                                                                                        |
| `pin` / `unpin` | Discord, Matrix, Microsoft Teams, Slack                                                                         | `--message-id`, `--target`                                     | `unpin` also accepts `--pinned-message-id` (Microsoft Teams: the pin/list-pins resource id, not the chat message id).                                                                                                                                                                                  |
| `pins` (list)   | Discord, Matrix, Microsoft Teams, Slack                                                                         | `--target`                                                     | `--limit`.                                                                                                                                                                                                                                                                                             |
| `permissions`   | Discord, Matrix                                                                                                 | `--target`                                                     | Matrix: available only when encryption is enabled and verification actions are allowed.                                                                                                                                                                                                                |
| `search`        | Discord                                                                                                         | `--guild-id`, `--query`                                        | `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`.                                                                                                                                                                                                           |
| `member info`   | Discord, Matrix, Microsoft Teams, Slack                                                                         | `--user-id`                                                    | `--guild-id` (Discord).                                                                                                                                                                                                                                                                                |

### Send

```bash
openclaw message send --channel discord \
  --target channel:123 --message "hi" --reply-to 456
```

- `--media <path-or-url>`: attach image/audio/video/document (local path or
  URL).
- `--presentation <json>`: shared payload with `text`, `context`, `divider`,
  `chart`, `table`, `buttons`, and `select` blocks, rendered per channel
  capability. See [Message Presentation](/plugins/message-presentation).
- `--delivery <json>`: generic delivery preferences, for example `{"pin":
true}`. `--pin` is shorthand for pinned delivery when the channel supports
  it.
- `--reply-to <id>`, `--thread-id <id>` (Telegram forum topic; Slack thread
  timestamp, same field as `--reply-to`).
- `--force-document` (Telegram, WhatsApp): send images/GIFs/videos as
  documents to avoid channel compression.
- `--silent` (Telegram, Discord): send without a notification.
- `--gif-playback` (WhatsApp only): treat video media as GIF playback.

```bash
openclaw message send --channel discord \
  --target channel:123 --message "Choose:" \
  --presentation '{"blocks":[{"type":"buttons","buttons":[{"label":"Approve","value":"approve","style":"success"},{"label":"Decline","value":"decline","style":"danger"}]}]}'
```

```bash
openclaw message send --channel telegram --target @mychat --message "Choose:" \
  --presentation '{"blocks":[{"type":"buttons","buttons":[{"label":"Yes","value":"cmd:yes"},{"label":"No","value":"cmd:no"}]}]}'
```

Slack renders supported chart blocks natively; other channels receive the same
data as readable text:

```bash
openclaw message send --channel slack --target channel:C123 \
  --presentation '{"blocks":[{"type":"chart","chartType":"bar","title":"Quarterly revenue","categories":["Q1","Q2"],"series":[{"name":"Revenue","values":[120,145]}],"xLabel":"Quarter"}]}'
```

Slack also renders explicit table blocks natively. Other channels receive the
caption and every row as deterministic text:

```bash
openclaw message send --channel slack --target channel:C123 \
  --presentation '{"title":"Pipeline report","blocks":[{"type":"table","caption":"Open pipeline","headers":["Account","Stage","ARR"],"rows":[["Acme","Won",125000],["Globex","Review",82000]],"rowHeaderColumnIndex":0}]}'
```

Telegram Mini App buttons use `webApp` (`web_app` still parses for legacy
JSON) and only render in private chats between a user and the bot:

```bash
openclaw message send --channel telegram --target 123456789 --message "Open app:" \
  --presentation '{"blocks":[{"type":"buttons","buttons":[{"label":"Launch","webApp":{"url":"https://example.com/app"}}]}]}'
```

```bash
openclaw message send --channel telegram --target @mychat \
  --media ./diagram.png --force-document
```

```bash
openclaw message send --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --presentation '{"title":"Status update","blocks":[{"type":"text","text":"Build completed"}]}'
```

### Poll

```bash
openclaw message poll --channel discord \
  --target channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

- `--poll-option <choice>`: repeat 2-12 times.
- `--poll-multi`: allow multiple selections.
- Discord: `--poll-duration-hours`, `--silent`, `--message`.
- Telegram: `--poll-duration-seconds <n>` (5-600), `--silent`,
  `--poll-anonymous` / `--poll-public`, `--thread-id`.

```bash
openclaw message poll --channel telegram \
  --target @mychat \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-duration-seconds 120 --silent
```

```bash
openclaw message poll --channel msteams \
  --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

### Threads

- `thread create`: channels Discord. Required: `--thread-name`, `--target`
  (channel id). Optional: `--message-id`, `--message`, `--auto-archive-min`.
- `thread list`: channels Discord. Required: `--guild-id`. Optional:
  `--channel-id`, `--include-archived`, `--before`, `--limit`.
- `thread reply`: channels Discord. Required: `--target` (thread id),
  `--message`. Optional: `--media`, `--reply-to`.

### Emojis

- `emoji list`: Discord (`--guild-id`), Slack (no extra flags).
- `emoji upload`: Discord. Required: `--guild-id`, `--emoji-name`, `--media`.
  Optional: `--role-ids` (repeat).

### Stickers

- `sticker send`: Discord. Required: `--target`, `--sticker-id` (repeat).
  Optional: `--message`.
- `sticker upload`: Discord. Required: `--guild-id`, `--sticker-name`,
  `--sticker-desc`, `--sticker-tags`, `--media`.

### Roles, channels, voice, events (Discord)

- `role info`: `--guild-id`.
- `role add` / `role remove`: `--guild-id`, `--user-id`, `--role-id`.
- `channel info`: `--target`.
- `channel list`: `--guild-id`.
- `voice status`: `--guild-id`, `--user-id`.
- `event list`: `--guild-id`.
- `event create`: required `--guild-id`, `--event-name`, `--start-time`;
  optional `--end-time`, `--desc`, `--channel-id`, `--location`,
  `--event-type`, `--image <url-or-path>`.

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id`; optional `--duration-min` or
  `--until` (omit both to clear the timeout), `--reason`.
- `kick`: `--guild-id`, `--user-id`, `--reason`.
- `ban`: `--guild-id`, `--user-id`, `--delete-days`, `--reason`.

### Broadcast

```bash
openclaw message broadcast --targets <target...> [--channel all] [--message <text>] [--media <url>] [--dry-run]
```

Sends one payload to multiple targets. `--targets` takes a space-separated
list. Use `--channel all` to target every configured provider.

## Related

- [CLI reference](/cli)
- [Agent send](/tools/agent-send)
- [Message Presentation](/plugins/message-presentation)
