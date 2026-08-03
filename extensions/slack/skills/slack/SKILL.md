---
name: slack
description: "Slack tool actions: send/read/edit/delete messages, react, pin/unpin, list pins/reactions/emoji, member info."
metadata: { "openclaw": { "emoji": "💬", "requires": { "config": ["channels.slack"] } } }
---

# Slack

Use the `slack` tool. Reuse `channelId` and Slack timestamp message IDs from context when present.

## Inputs

- `channelId`: Slack channel ID.
- `messageId`: Slack timestamp, e.g. `1712023032.1234`.
- `to`: `channel:<id>` or `user:<id>` for sends.
- `emoji`: Unicode or `:name:` for reactions.

## Actions

```json
{ "action": "sendMessage", "to": "channel:C123", "content": "Hello" }
```

```json
{ "action": "readMessages", "channelId": "C123", "limit": 20 }
```

```json
{
  "action": "react",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "emoji": ":white_check_mark:"
}
```

```json
{ "action": "reactions", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{
  "action": "editMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "content": "Updated text"
}
```

```json
{ "action": "deleteMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "pinMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "unpinMessage", "channelId": "C123", "messageId": "1712023032.1234" }
```

```json
{ "action": "listPins", "channelId": "C123" }
```

```json
{ "action": "memberInfo", "userId": "U123" }
```

```json
{ "action": "emojiList" }
```

## Safety

- Confirm destructive deletes when context is unclear.
- Keep outbound messages short; avoid Markdown tables.
- Prefer thread/message IDs over fuzzy channel names.
