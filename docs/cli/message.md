---
summary: "CLI reference for `clawdbot message` (send + channel actions)"
read_when:
  - Adding or modifying message CLI actions
  - Changing outbound channel behavior
---

# `clawdbot message`

Single outbound command for sending messages and channel actions
(Discord/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams).

## Usage

```
clawdbot message <subcommand> [flags]
```

Channel selection:
- `--channel` required if more than one channel is configured.
- If exactly one channel is configured, it becomes the default.
- Values: `whatsapp|telegram|discord|slack|signal|imessage|msteams`

Target formats (`--to`):
- WhatsApp: E.164 or group JID
- Telegram: chat id or `@username`
- Discord: `channel:<id>` or `user:<id>` (or `<@id>` mention; raw numeric ids are rejected)
- Slack: `channel:<id>` or `user:<id>` (raw channel id is accepted)
- Signal: `+E.164`, `group:<id>`, `signal:+E.164`, `signal:group:<id>`, or `username:<name>`/`u:<name>`
- iMessage: handle, `chat_id:<id>`, `chat_guid:<guid>`, or `chat_identifier:<id>`
- MS Teams: conversation id (`19:...@thread.tacv2`) or `conversation:<id>` or `user:<aad-object-id>`

## Common flags

- `--channel <name>`
- `--account <id>`
- `--json`
- `--dry-run`
- `--verbose`

## Actions

### Core

- `send`
  - Channels: WhatsApp/Telegram/Discord/Slack/Signal/iMessage/MS Teams
  - Required: `--to`, `--message`
  - Optional: `--media`, `--reply-to`, `--thread-id`, `--gif-playback`
  - Telegram only: `--buttons` (requires `"inlineButtons"` in `channels.telegram.capabilities` or `channels.telegram.accounts.<id>.capabilities`)
  - Telegram only: `--thread-id` (forum topic id)
  - Slack only: `--thread-id` (thread timestamp; `--reply-to` uses the same field)
  - WhatsApp only: `--gif-playback`

- `poll`
  - Channels: WhatsApp/Discord/MS Teams
  - Required: `--to`, `--poll-question`, `--poll-option` (repeat)
  - Optional: `--poll-multi`
  - Discord only: `--poll-duration-hours`, `--message`

- `react`
  - Channels: Discord/Slack/Telegram/WhatsApp
  - Required: `--message-id`, `--to` or `--channel-id`
  - Optional: `--emoji`, `--remove`, `--participant`, `--from-me`, `--channel-id`
  - Note: `--remove` requires `--emoji` (omit `--emoji` to clear own reactions where supported; see /tools/reactions)
  - WhatsApp only: `--participant`, `--from-me`

- `reactions`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--to` or `--channel-id`
  - Optional: `--limit`, `--channel-id`

- `read`
  - Channels: Discord/Slack
  - Required: `--to` or `--channel-id`
  - Optional: `--limit`, `--before`, `--after`, `--channel-id`
  - Discord only: `--around`

- `edit`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--message`, `--to` or `--channel-id`
  - Optional: `--channel-id`

- `delete`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--to` or `--channel-id`
  - Optional: `--channel-id`

- `pin` / `unpin`
  - Channels: Discord/Slack
  - Required: `--message-id`, `--to` or `--channel-id`
  - Optional: `--channel-id`

- `pins` (list)
  - Channels: Discord/Slack
  - Required: `--to` or `--channel-id`
  - Optional: `--channel-id`

- `permissions`
  - Channels: Discord
  - Required: `--to` or `--channel-id`
  - Optional: `--channel-id`

- `search`
  - Channels: Discord
  - Required: `--guild-id`, `--query`
  - Optional: `--channel-id`, `--channel-ids` (repeat), `--author-id`, `--author-ids` (repeat), `--limit`

### Threads

- `thread create`
  - Channels: Discord
  - Required: `--thread-name`, `--to` (channel id) or `--channel-id`
  - Optional: `--message-id`, `--auto-archive-min`

- `thread list`
  - Channels: Discord
  - Required: `--guild-id`
  - Optional: `--channel-id`, `--include-archived`, `--before`, `--limit`

- `thread reply`
  - Channels: Discord
  - Required: `--to` (thread id), `--message`
  - Optional: `--media`, `--reply-to`

### Emojis

- `emoji list`
  - Discord: `--guild-id`
  - Slack: no extra flags

- `emoji upload`
  - Channels: Discord
  - Required: `--guild-id`, `--emoji-name`, `--media`
  - Optional: `--role-ids` (repeat)

### Stickers

- `sticker send`
  - Channels: Discord
  - Required: `--to`, `--sticker-id` (repeat)
  - Optional: `--message`

- `sticker upload`
  - Channels: Discord
  - Required: `--guild-id`, `--sticker-name`, `--sticker-desc`, `--sticker-tags`, `--media`

### Roles / Channels / Members / Voice

- `role info` (Discord): `--guild-id`
- `role add` / `role remove` (Discord): `--guild-id`, `--user-id`, `--role-id`
- `channel info` (Discord): `--channel-id`
- `channel list` (Discord): `--guild-id`
- `member info` (Discord/Slack): `--user-id` (+ `--guild-id` for Discord)
- `voice status` (Discord): `--guild-id`, `--user-id`

### Events

- `event list` (Discord): `--guild-id`
- `event create` (Discord): `--guild-id`, `--event-name`, `--start-time`
  - Optional: `--end-time`, `--desc`, `--channel-id`, `--location`, `--event-type`

### Moderation (Discord)

- `timeout`: `--guild-id`, `--user-id` (optional `--duration-min` or `--until`; omit both to clear timeout)
- `kick`: `--guild-id`, `--user-id` (+ `--reason`)
- `ban`: `--guild-id`, `--user-id` (+ `--delete-days`, `--reason`)
  - `timeout` also supports `--reason`

## Examples

Send a Discord reply:
```
clawdbot message send --channel discord \
  --to channel:123 --message "hi" --reply-to 456
```

Create a Discord poll:
```
clawdbot message poll --channel discord \
  --to channel:123 \
  --poll-question "Snack?" \
  --poll-option Pizza --poll-option Sushi \
  --poll-multi --poll-duration-hours 48
```

Send a Teams proactive message:
```
clawdbot message send --channel msteams \
  --to conversation:19:abc@thread.tacv2 --message "hi"
```

Create a Teams poll:
```
clawdbot message poll --channel msteams \
  --to conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" \
  --poll-option Pizza --poll-option Sushi
```

React in Slack:
```
clawdbot message react --channel slack \
  --to C123 --message-id 456 --emoji "✅"
```

Send Telegram inline buttons:
```
clawdbot message send --channel telegram --to @mychat --message "Choose:" \
  --buttons '[ [{"text":"Yes","callback_data":"cmd:yes"}], [{"text":"No","callback_data":"cmd:no"}] ]'
```
