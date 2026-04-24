---
name: bluebubbles
description: Send and manage iMessages via BlueBubbles, including attachments, tapbacks, edits, replies, and groups.
metadata: { "openclaw": { "emoji": "🫧", "requires": { "config": ["channels.bluebubbles"] } } }
---

# BlueBubbles Actions

## Overview

BlueBubbles is OpenClaw’s recommended iMessage integration. Use the `message` tool with `channel: "bluebubbles"` to send messages and manage iMessage conversations: send texts and attachments, react (tapbacks), edit/unsend, reply in threads, and manage group participants/names/icons.

## Inputs to collect

- `target` (prefer `chat_guid:...`; also `+15551234567` in E.164 or `user@example.com`)
- `message` text for send/edit/reply
- `messageId` for react/edit/unsend/reply
- Attachment `path` for local files, or `buffer` + `filename` for base64

If the user is vague ("text my mom"), ask for the recipient handle or chat guid and the exact message content.

## Actions

### Send a message

```json
{
  "action": "send",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "hello from OpenClaw"
}
```

### React (tapback)

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️"
}
```

### Remove a reaction

```json
{
  "action": "react",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "emoji": "❤️",
  "remove": true
}
```

### Edit a previously sent message

```json
{
  "action": "edit",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>",
  "message": "updated text"
}
```

### Unsend a message

```json
{
  "action": "unsend",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "messageId": "<message-guid>"
}
```

### Reply to a specific message

```json
{
  "action": "reply",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "replyTo": "<message-guid>",
  "message": "replying to that"
}
```

### Send an attachment

```json
{
  "action": "sendAttachment",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "path": "/tmp/photo.jpg",
  "caption": "here you go"
}
```

### Send with an iMessage effect

```json
{
  "action": "sendWithEffect",
  "channel": "bluebubbles",
  "target": "+15551234567",
  "message": "big news",
  "effect": "balloons"
}
```

## Notes

- Requires gateway config `channels.bluebubbles` (serverUrl/password/webhookPath).
- Prefer `chat_guid` targets when you have them (especially for group chats).
- BlueBubbles supports rich actions, but some are macOS-version dependent (for example, edit may be broken on macOS 26 Tahoe).
- The gateway may expose both short and full message ids; full ids are more durable across restarts.
- Developer reference for the underlying plugin lives in the BlueBubbles plugin package README.

## Ideas to try

- React with a tapback to acknowledge a request.
- Reply in-thread when a user references a specific message.
- Send a file attachment with a short caption.
