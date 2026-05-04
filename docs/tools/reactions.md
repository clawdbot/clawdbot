---
summary: "Reaction tool semantics across all supported channels"
read_when:
  - Working on reactions in any channel
  - Understanding how emoji reactions differ across platforms
title: "Reactions"
---

The agent can add and remove emoji reactions on messages using the `message`
tool with the `react` action. Reaction behavior varies by channel and transport.

## How it works

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- `emoji` is required when adding a reaction.
- Set `emoji` to an empty string (`""`) to remove the bot's reaction(s).
- Set `remove: true` to remove a specific emoji (requires non-empty `emoji`).
- On channels that support status reactions, `trackToolCalls: true` on a
  reaction lets the runtime use that reacted message for subsequent tool
  progress reactions during the same turn.

## Channel behavior

<AccordionGroup>
  <Accordion title="Discord and Slack">
    - Empty `emoji` removes all of the bot's reactions on the message.
    - `remove: true` removes just the specified emoji.

  </Accordion>

  <Accordion title="Google Chat">
    - Empty `emoji` removes the app's reactions on the message.
    - `remove: true` removes just the specified emoji.

  </Accordion>

  <Accordion title="Telegram">
    - Empty `emoji` removes the bot's reactions.
    - `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.

  </Accordion>

  <Accordion title="WhatsApp">
    - Empty `emoji` removes the bot reaction.
    - `remove: true` maps to empty emoji internally (still requires `emoji` in the tool call).

  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - Requires non-empty `emoji`.
    - `remove: true` removes that specific emoji reaction.

  </Accordion>

  <Accordion title="Feishu/Lark">
    - Use the `feishu_reaction` tool with actions `add`, `remove`, and `list`.
    - Add/remove requires `emoji_type`; remove also requires `reaction_id`.

  </Accordion>

  <Accordion title="Signal">
    - Inbound reaction notifications are controlled by `channels.signal.reactionNotifications`: `"off"` disables them, `"own"` (default) emits events when users react to bot messages, and `"all"` emits events for all reactions.

  </Accordion>
</AccordionGroup>

## Reaction level

Per-channel `reactionLevel` config controls how broadly the agent uses reactions. Values are typically `off`, `ack`, `minimal`, or `extensive`.

- [Telegram reactionLevel](/channels/telegram#reaction-notifications) — `channels.telegram.reactionLevel`
- [WhatsApp reactionLevel](/channels/whatsapp#reaction-level) — `channels.whatsapp.reactionLevel`

Set `reactionLevel` on individual channels to tune how actively the agent reacts to messages on each platform.

## Related

- [Agent Send](/tools/agent-send) — the `message` tool that includes `react`
- [Channels](/channels) — channel-specific configuration
