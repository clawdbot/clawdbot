---
name: discord
description: "Discord messaging workflows through OpenClaw's message tool."
metadata: { "openclaw": { "emoji": "🎮", "requires": { "config": ["channels.discord.token"] } } }
allowed-tools: ["message"]
---

# Discord

Use the `message` tool with `channel: "discord"`. The tool schema lists the actions enabled by the current account's `channels.discord.actions.*` gates; do not assume unavailable actions.

## Workflow

- Prefer stable `guildId`, `channelId`, `messageId`, and `userId` values from context. Pass `accountId` when more than one Discord account could apply.
- Resolve the exact message before editing, deleting, pinning, moderating, or reacting when the user's reference is ambiguous.
- Keep thread replies in their existing thread. A forum parent cannot receive components; send components to the created forum thread instead.
- Confirm destructive or moderation actions unless the user already specified the exact target and action.

## Interactive components

`components` must be a structured object or native component array, never a placeholder string. Do not combine components v2 with legacy `embeds`.

```json
{
  "action": "send",
  "channel": "discord",
  "to": "channel:123",
  "message": "Choose an option",
  "components": {
    "blocks": [
      {
        "type": "actions",
        "buttons": [
          { "label": "Approve", "style": "success", "callbackData": "approve" },
          { "label": "Decline", "style": "danger", "callbackData": "decline" }
        ]
      }
    ]
  }
}
```

Discord mention syntax, component availability, and form hints are injected automatically. Follow the current hints and tool schema rather than a duplicated action catalog.
