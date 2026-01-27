---
name: discord
description: Use when you need to control Discord from Moltbot via the discord tool: send messages, react, post or upload stickers, upload emojis, run polls, manage threads/pins/search, create/edit/delete channels and categories, fetch permissions or member/role/channel info, or handle moderation actions in Discord DMs or channels.
metadata: {"moltbot":{"emoji":"🎮","requires":{"config":["channels.discord"]}}}
---

# Discord Actions

## Overview

Use `discord` to manage messages, reactions, threads, polls, and moderation. You can disable groups via `discord.actions.*` (defaults to enabled, except roles/moderation). The tool uses the bot token configured for Moltbot.

## Inputs to collect

- For reactions: `channelId`, `messageId`, and an `emoji`.
- For fetchMessage: `guildId`, `channelId`, `messageId`, or a `messageLink` like `https://discord.com/channels/<guildId>/<channelId>/<messageId>`.
- For stickers/polls/sendMessage: a `to` target (`channel:<id>` or `user:<id>`). Optional `content` text.
- Polls also need a `question` plus 2–10 `answers`.
- For media: `mediaUrl` with `file:///path` for local files or `https://...` for remote.
- For emoji uploads: `guildId`, `name`, `mediaUrl`, optional `roleIds` (limit 256KB, PNG/JPG/GIF).
- For sticker uploads: `guildId`, `name`, `description`, `tags`, `mediaUrl` (limit 512KB, PNG/APNG/Lottie JSON).

Message context lines include `discord message id` and `channel` fields you can reuse directly.

**Note:** `sendMessage` uses `to: "channel:<id>"` format, not `channelId`. Other actions like `react`, `readMessages`, `editMessage` use `channelId` directly.
**Note:** `fetchMessage` accepts message IDs or full links like `https://discord.com/channels/<guildId>/<channelId>/<messageId>`.

## Actions

### React to a message

```json
{
  "action": "react",
  "channelId": "123",
  "messageId": "456",
  "emoji": "✅"
}
```

### List reactions + users

```json
{
  "action": "reactions",
  "channelId": "123",
  "messageId": "456",
  "limit": 100
}
```

### Send a sticker

```json
{
  "action": "sticker",
  "to": "channel:123",
  "stickerIds": ["9876543210"],
  "content": "Nice work!"
}
```

- Up to 3 sticker IDs per message.
- `to` can be `user:<id>` for DMs.

### Upload a custom emoji

```json
{
  "action": "emojiUpload",
  "guildId": "999",
  "name": "party_blob",
  "mediaUrl": "file:///tmp/party.png",
  "roleIds": ["222"]
}
```

- Emoji images must be PNG/JPG/GIF and <= 256KB.
- `roleIds` is optional; omit to make the emoji available to everyone.

### Upload a sticker

```json
{
  "action": "stickerUpload",
  "guildId": "999",
  "name": "moltbot_wave",
  "description": "Moltbot waving hello",
  "tags": "👋",
  "mediaUrl": "file:///tmp/wave.png"
}
```

- Stickers require `name`, `description`, and `tags`.
- Uploads must be PNG/APNG/Lottie JSON and <= 512KB.

### Create a poll

```json
{
  "action": "poll",
  "to": "channel:123",
  "question": "Lunch?",
  "answers": ["Pizza", "Sushi", "Salad"],
  "allowMultiselect": false,
  "durationHours": 24,
  "content": "Vote now"
}
```

- `durationHours` defaults to 24; max 32 days (768 hours).

### Check bot permissions for a channel

```json
{
  "action": "permissions",
  "channelId": "123"
}
```

## Ideas to try

- React with ✅/⚠️ to mark status updates.
- Post a quick poll for release decisions or meeting times.
- Send celebratory stickers after successful deploys.
- Upload new emojis/stickers for release moments.
- Run weekly “priority check” polls in team channels.
- DM stickers as acknowledgements when a user’s request is completed.

## Action gating

Use `discord.actions.*` to disable action groups:
- `reactions` (react + reactions list + emojiList)
- `stickers`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
- `emojiUploads`, `stickerUploads`
- `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
- `roles` (role add/remove, default `false`)
- `channels` (channel/category create/edit/delete/move, default `false`)
- `moderation` (timeout/kick/ban, default `false`)
### Read recent messages

```json
{
  "action": "readMessages",
  "channelId": "123",
  "limit": 20
}
```

### Fetch a single message

```json
{
  "action": "fetchMessage",
  "guildId": "999",
  "channelId": "123",
  "messageId": "456"
}
```

```json
{
  "action": "fetchMessage",
  "messageLink": "https://discord.com/channels/999/123/456"
}
```

### Send/edit/delete a message

```json
{
  "action": "sendMessage",
  "to": "channel:123",
  "content": "Hello from Moltbot"
}
```

**With media attachment:**

```json
{
  "action": "sendMessage",
  "to": "channel:123",
  "content": "Check out this audio!",
  "mediaUrl": "file:///tmp/audio.mp3"
}
```

- `to` uses format `channel:<id>` or `user:<id>` for DMs (not `channelId`!)
- `mediaUrl` supports local files (`file:///path/to/file`) and remote URLs (`https://...`)
- Optional `replyTo` with a message ID to reply to a specific message

```json
{
  "action": "editMessage",
  "channelId": "123",
  "messageId": "456",
  "content": "Fixed typo"
}
```

```json
{
  "action": "deleteMessage",
  "channelId": "123",
  "messageId": "456"
}
```

### Threads

```json
{
  "action": "threadCreate",
  "channelId": "123",
  "name": "Bug triage",
  "messageId": "456"
}
```

```json
{
  "action": "threadList",
  "guildId": "999"
}
```

```json
{
  "action": "threadReply",
  "channelId": "777",
  "content": "Replying in thread"
}
```

### Pins

```json
{
  "action": "pinMessage",
  "channelId": "123",
  "messageId": "456"
}
```

```json
{
  "action": "listPins",
  "channelId": "123"
}
```

### Search messages

```json
{
  "action": "searchMessages",
  "guildId": "999",
  "content": "release notes",
  "channelIds": ["123", "456"],
  "limit": 10
}
```

### Member + role info

```json
{
  "action": "memberInfo",
  "guildId": "999",
  "userId": "111"
}
```

```json
{
  "action": "roleInfo",
  "guildId": "999"
}
```

### List available custom emojis

```json
{
  "action": "emojiList",
  "guildId": "999"
}
```

### Role changes (disabled by default)

```json
{
  "action": "roleAdd",
  "guildId": "999",
  "userId": "111",
  "roleId": "222"
}
```

### Channel info

```json
{
  "action": "channelInfo",
  "channelId": "123"
}
```

```json
{
  "action": "channelList",
  "guildId": "999"
}
```

### Channel management (disabled by default)

Create, edit, delete, and move channels and categories. Enable via `discord.actions.channels: true`.

**Create a text channel:**

```json
{
  "action": "channelCreate",
  "guildId": "999",
  "name": "general-chat",
  "type": 0,
  "parentId": "888",
  "topic": "General discussion"
}
```

- `type`: Discord channel type integer (0 = text, 2 = voice, 4 = category; other values supported)
- `parentId`: category ID to nest under (optional)
- `topic`, `position`, `nsfw`: optional

**Create a category:**

```json
{
  "action": "categoryCreate",
  "guildId": "999",
  "name": "Projects"
}
```

**Edit a channel:**

```json
{
  "action": "channelEdit",
  "channelId": "123",
  "name": "new-name",
  "topic": "Updated topic"
}
```

- Supports `name`, `topic`, `position`, `parentId` (null to remove from category), `nsfw`, `rateLimitPerUser`

**Move a channel:**

```json
{
  "action": "channelMove",
  "guildId": "999",
  "channelId": "123",
  "parentId": "888",
  "position": 2
}
```

- `parentId`: target category (null to move to top level)

**Delete a channel:**

```json
{
  "action": "channelDelete",
  "channelId": "123"
}
```

**Edit/delete a category:**

```json
{
  "action": "categoryEdit",
  "categoryId": "888",
  "name": "Renamed Category"
}
```

```json
{
  "action": "categoryDelete",
  "categoryId": "888"
}
```

### Voice status

```json
{
  "action": "voiceStatus",
  "guildId": "999",
  "userId": "111"
}
```

### Scheduled events

```json
{
  "action": "eventList",
  "guildId": "999"
}
```

### Moderation (disabled by default)

```json
{
  "action": "timeout",
  "guildId": "999",
  "userId": "111",
  "durationMinutes": 10
}
```

## Discord Writing Style Guide

**Keep it conversational!** Discord is a chat platform, not documentation.

### Do
- Short, punchy messages (1-3 sentences ideal)
- Multiple quick replies > one wall of text
- Use emoji for tone/emphasis 🦞
- Lowercase casual style is fine
- Break up info into digestible chunks
- Match the energy of the conversation

### Don't
- No markdown tables (Discord renders them as ugly raw `| text |`)
- No `## Headers` for casual chat (use **bold** or CAPS for emphasis)
- Avoid multi-paragraph essays
- Don't over-explain simple things
- Skip the "I'd be happy to help!" fluff

### Formatting that works
- **bold** for emphasis
- `code` for technical terms
- Lists for multiple items
- > quotes for referencing
- Wrap multiple links in `<>` to suppress embeds

### Example transformations

❌ Bad:
```
I'd be happy to help with that! Here's a comprehensive overview of the versioning strategies available:

## Semantic Versioning
Semver uses MAJOR.MINOR.PATCH format where...

## Calendar Versioning
CalVer uses date-based versions like...
```

✅ Good:
```
versioning options: semver (1.2.3), calver (2026.01.04), or yolo (`latest` forever). what fits your release cadence?
```
