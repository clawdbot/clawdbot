---
name: discord
description: "Discord message-tool ops: send/read/edit/delete, react, poll, pin, thread, search, presence, media/components."
metadata: { "openclaw": { "emoji": "🎮", "requires": { "config": ["channels.discord.token"] } } }
allowed-tools: ["message"]
---

# Discord

Use the `message` tool with `channel: "discord"`. No separate Discord tool.

## Rules

- Respect `channels.discord.actions.*` gates.
- Prefer explicit `guildId`, `channelId`, `messageId`, `userId`.
- Multi-account: pass `accountId` when needed.
- Send targets: `to: "channel:<id>"` or `to: "user:<id>"`.
- Mention users as `<@USER_ID>`.
- Avoid Markdown tables in outbound Discord messages.
- Prefer components v2 for rich UI; do not mix v2 `components` with legacy `embeds`.

## Common actions

Send:

```json
{ "action": "send", "channel": "discord", "to": "channel:123", "message": "hello", "silent": true }
```

Send media:

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "see attachment",
  "media": "file:///tmp/example.png"
}
```

Components v2:

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "Status",
  "components": "[Carbon v2 components]"
}
```

React:

```json
{ "action": "react", "channel": "discord", "channelId": "123", "messageId": "456", "emoji": "👍" }
```

Read:

```json
{ "action": "read", "channel": "discord", "to": "channel:123", "limit": 20 }
```

Edit/delete:

```json
{
  "action": "edit",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "message": "fixed typo"
}
```

```json
{ "action": "delete", "channel": "discord", "channelId": "123", "messageId": "456" }
```

Poll:

```json
{
  "action": "poll",
  "channel": "discord",
  "to": "channel:123",
  "pollQuestion": "Lunch?",
  "pollOption": ["Pizza", "Sushi"],
  "pollDurationHours": 24
}
```

Pin:

```json
{ "action": "pin", "channel": "discord", "channelId": "123", "messageId": "456" }
```

Thread:

```json
{
  "action": "thread-create",
  "channel": "discord",
  "channelId": "123",
  "messageId": "456",
  "threadName": "bug triage"
}
```

Search:

```json
{
  "action": "search",
  "channel": "discord",
  "guildId": "999",
  "query": "release notes",
  "channelIds": ["123"],
  "limit": 10
}
```

Presence, often gated:

```json
{
  "action": "set-presence",
  "channel": "discord",
  "activityType": "playing",
  "activityName": "OpenClaw",
  "status": "online"
}
```
