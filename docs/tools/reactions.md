---
summary: "Reaction tool semantics across all supported channels"
read_when:
  - Working on reactions in any channel
  - Understanding how emoji reactions differ across platforms
title: "Reactions"
---

The agent adds and removes emoji reactions with the `message` tool's `react`
action. Behavior varies by channel.

## How it works

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- `emoji` is required when adding a reaction.
- Set `emoji` to an empty string (`""`) to remove the bot's reaction(s) on
  channels that support it.
- Set `remove: true` to remove one specific emoji (requires non-empty
  `emoji`).
- On channels with status reactions, `trackToolCalls: true` on a reaction lets
  the runtime reuse that reacted message for subsequent tool-progress
  reactions during the same turn.

## Channel behavior

<AccordionGroup>
  <Accordion title="Discord and Slack">
    - Empty `emoji` removes all of the bot's reactions on the message.
    - `remove: true` removes just the specified emoji.

  </Accordion>

  <Accordion title="Nextcloud Talk">
    - Adding reactions only: `emoji` is required and must be non-empty.
    - Reaction removal is not wired to a delete call yet; `remove: true` is rejected with an explicit error instead of silently no-oping.
    - Requires the Talk bot registered with the `reaction` feature (see [Nextcloud Talk channel docs](/channels/nextcloud-talk)).

  </Accordion>

  <Accordion title="Telegram">
    - Empty `emoji` removes the bot's reactions.
    - `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.

  </Accordion>

  <Accordion title="WhatsApp">
    - Empty `emoji` removes the bot reaction.
    - `remove: true` maps to empty emoji internally (still requires `emoji` in the tool call).
    - WhatsApp has one bot reaction slot per message; sending a new reaction replaces it rather than stacking multiple emoji.

  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - Requires non-empty `emoji` for both add and remove.
    - `remove: true` removes that specific emoji reaction.

  </Accordion>

  <Accordion title="Feishu/Lark">
    - Uses the same `react` action as other channels (add/remove/list via message reaction IDs), not a separate tool.
    - Adding requires non-empty `emoji` (mapped to a Feishu `emoji_type`, e.g. `SMILE`, `THUMBSUP`, `HEART`).
    - `remove: true` requires non-empty `emoji` and removes the bot's own reaction matching that emoji type.
    - Empty `emoji` with `clearAll: true` removes all of the bot's reactions on the message.

  </Accordion>

  <Accordion title="Signal">
    - Inbound reaction notifications are controlled by `channels.signal.reactionNotifications`: `"off"` disables them, `"own"` (default) emits events when users react to bot messages, `"all"` emits events for all reactions, and `"allowlist"` emits events only for senders in `channels.signal.reactionAllowlist`.

  </Accordion>

  <Accordion title="iMessage">
    - Outbound reactions are iMessage tapbacks (`love`, `like`, `dislike`, `laugh`, `emphasize`, and `question`); `emoji` must map to one of these kinds to add a reaction.
    - `remove: true` without a recognized tapback kind removes all tapback kinds; with a recognized kind it removes just that one.

  </Accordion>
</AccordionGroup>

## Reaction level

Per-channel `reactionLevel` throttles how often the agent sends its own
reactions. Values: `off`, `ack`, `minimal`, or `extensive`.

- [Telegram reaction notifications](/channels/telegram#feature-reference) - `channels.telegram.reactionLevel` (default `minimal`)
- [WhatsApp reaction level](/channels/whatsapp#reaction-level) - `channels.whatsapp.reactionLevel` (default `minimal`)
- [Signal reactions](/channels/signal#reactions-message-tool) - `channels.signal.reactionLevel` (default `minimal`)

## Related

- [Agent Send](/tools/agent-send) - the `message` tool that includes `react`
- [Channels](/channels) - channel-specific configuration
