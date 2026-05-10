---
summary: "Semantic message cards, buttons, selects, fallback text, and delivery hints for channel plugins"
title: "Message presentation"
read_when:
  - Adding or modifying message card, button, or select rendering
  - Building a channel plugin that supports rich outbound messages
  - Changing message tool presentation or delivery capabilities
  - Debugging provider-specific card/block/component rendering regressions
---

Message presentation is OpenClaw's shared contract for rich outbound chat UI.
It lets agents, CLI commands, approval flows, and plugins describe the message
intent once, while each channel plugin renders the best native shape it can.

Use presentation for portable message UI:

- text sections
- small context/footer text
- dividers
- buttons
- select menus
- card title and tone

Do not add new provider-native fields such as Discord `components`, Slack
`blocks`, Telegram `buttons`, Teams `card`, or Feishu `card` to the shared
message tool. Those are renderer outputs owned by the channel plugin.

## Contract

Plugin authors import the public contract from:

```ts
import type {
  MessagePresentation,
  ReplyPayloadDelivery,
} from "openclaw/plugin-sdk/interactive-runtime";
```

Shape:

```ts
type MessagePresentation = {
  title?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  blocks: MessagePresentationBlock[];
};

type MessagePresentationBlock =
  | { type: "text"; text: string }
  | { type: "context"; text: string }
  | { type: "divider" }
  | { type: "buttons"; buttons: MessagePresentationButton[] }
  | { type: "select"; placeholder?: string; options: MessagePresentationOption[] };

type MessagePresentationButton = {
  label: string;
  value?: string;
  url?: string;
  style?: "primary" | "secondary" | "success" | "danger";
};

type MessagePresentationOption = {
  label: string;
  value: string;
};

type ReplyPayloadDelivery = {
  pin?:
    | boolean
    | {
        enabled: boolean;
        notify?: boolean;
        required?: boolean;
      };
};
```

Button semantics:

- `value` is an application action value routed back through the channel's
  existing interaction path when the channel supports clickable controls.
- `url` is a link button. It can exist without `value`.
- `label` is required and is also used in text fallback.
- `style` is advisory. Renderers should map unsupported styles to a safe
  default, not fail the send.

Select semantics:

- `options[].value` is the selected application value.
- `placeholder` is advisory and may be ignored by channels without native
  select support.
- If a channel does not support selects, fallback text lists the labels.

## Producer examples

Simple card:

```json
{
  "title": "Deploy approval",
  "tone": "warning",
  "blocks": [
    { "type": "text", "text": "Canary is ready to promote." },
    { "type": "context", "text": "Build 1234, staging passed." },
    {
      "type": "buttons",
      "buttons": [
        { "label": "Approve", "value": "deploy:approve", "style": "success" },
        { "label": "Decline", "value": "deploy:decline", "style": "danger" }
      ]
    }
  ]
}
```

URL-only link button:

```json
{
  "blocks": [
    { "type": "text", "text": "Release notes are ready." },
    {
      "type": "buttons",
      "buttons": [{ "label": "Open notes", "url": "https://example.com/release" }]
    }
  ]
}
```

Select menu:

```json
{
  "title": "Choose environment",
  "blocks": [
    {
      "type": "select",
      "placeholder": "Environment",
      "options": [
        { "label": "Canary", "value": "env:canary" },
        { "label": "Production", "value": "env:prod" }
      ]
    }
  ]
}
```

CLI send:

```bash
openclaw message send --channel slack \
  --target channel:C123 \
  --message "Deploy approval" \
  --presentation '{"title":"Deploy approval","tone":"warning","blocks":[{"type":"text","text":"Canary is ready."},{"type":"buttons","buttons":[{"label":"Approve","value":"deploy:approve","style":"success"},{"label":"Decline","value":"deploy:decline","style":"danger"}]}]}'
```

Pinned delivery:

```bash
openclaw message send --channel telegram \
  --target -1001234567890 \
  --message "Topic opened" \
  --pin
```

Pinned delivery with explicit JSON:

```json
{
  "pin": {
    "enabled": true,
    "notify": true,
    "required": false
  }
}
```

## Renderer contract

Channel plugins declare render support on their outbound adapter:

```ts
const adapter: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
  },
  deliveryCapabilities: {
    pin: true,
  },
  renderPresentation({ payload, presentation, ctx }) {
    return renderNativePayload(payload, presentation, ctx);
  },
  async pinDeliveredMessage({ target, messageId, pin }) {
    await pinNativeMessage(target, messageId, { notify: pin.notify === true });
  },
};
```

Capability fields are intentionally simple booleans. They describe what the
renderer can make interactive, not every native platform limit. Renderers still
own platform-specific limits such as maximum button count, block count, and
card size.

## Core render flow

When a `ReplyPayload` or message action includes `presentation`, core:

1. Normalizes the presentation payload.
2. Resolves the target channel's outbound adapter.
3. Reads `presentationCapabilities`.
4. Calls `renderPresentation` when the adapter can render the payload.
5. Falls back to conservative text when the adapter is absent or cannot render.
6. Sends the resulting payload through the normal channel delivery path.
7. Applies delivery metadata such as `delivery.pin` after the first successful
   sent message.

Core owns fallback behavior so producers can stay channel-agnostic. Channel
plugins own native rendering and interaction handling.

## Degradation rules

Presentation must be safe to send on limited channels.

Fallback text includes:

- `title` as the first line
- `text` blocks as normal paragraphs
- `context` blocks as compact context lines
- `divider` blocks as a visual separator
- button labels, including URLs for link buttons
- select option labels

Unsupported native controls should degrade rather than fail the whole send.
Examples:

- Telegram with inline buttons disabled sends text fallback.
- A channel without select support lists select options as text.
- A URL-only button becomes either a native link button or a fallback URL line.
- Optional pin failures do not fail the delivered message.

The main exception is `delivery.pin.required: true`; if pinning is requested as
required and the channel cannot pin the sent message, delivery reports failure.

## Provider mapping

Current bundled renderers:

| Channel         | Native render target                | Notes                                                                                                                                             |
| --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord         | Components and component containers | Preserves legacy `channelData.discord.components` for existing provider-native payload producers, but new shared sends should use `presentation`. |
| Slack           | Block Kit                           | Preserves legacy `channelData.slack.blocks` for existing provider-native payload producers, but new shared sends should use `presentation`.       |
| Telegram        | Text plus inline keyboards          | Buttons/selects require inline button capability for the target surface; otherwise text fallback is used.                                         |
| Mattermost      | Text plus interactive props         | Other blocks degrade to text.                                                                                                                     |
| Microsoft Teams | Adaptive Cards                      | Plain `message` text is included with the card when both are provided.                                                                            |
| Feishu          | Interactive cards                   | Card header can use `title`; body avoids duplicating that title.                                                                                  |
| Plain channels  | Text fallback                       | Channels without a renderer still get readable output.                                                                                            |

Provider-native payload compatibility is a transition affordance for existing
reply producers. It is not a reason to add new shared native fields.

## Presentation vs InteractiveReply

`InteractiveReply` is the older internal subset used by approval and interaction
helpers. It supports:

- text
- buttons
- selects

`MessagePresentation` is the canonical shared send contract. It adds:

- title
- tone
- context
- divider
- URL-only buttons
- generic delivery metadata through `ReplyPayload.delivery`

Use helpers from `openclaw/plugin-sdk/interactive-runtime` when bridging older
code:

```ts
import {
  interactiveReplyToPresentation,
  normalizeMessagePresentation,
  presentationToInteractiveControlsReply,
  presentationToInteractiveReply,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
```

New code should accept or produce `MessagePresentation` directly.

`presentationToInteractiveReply(...)` preserves visible presentation text by
mapping the title, text, context, buttons, and selects into the older
`InteractiveReply` shape. Component renderers that already draw title, text,
context, and divider blocks natively should use
`presentationToInteractiveControlsReply(...)` instead, then append only the
button and select controls.

`renderMessagePresentationFallbackText(...)` returns an empty string for
presentation blocks that have no text fallback, such as a divider-only
presentation. Transports that require a non-empty send body can pass
`emptyFallback` to opt into a minimal body without changing the default fallback
contract.

## Delivery pin

Pinning is delivery behavior, not presentation. Use `delivery.pin` instead of
provider-native fields such as `channelData.telegram.pin`.

Semantics:

- `pin: true` pins the first successfully delivered message.
- `pin.notify` defaults to `false`.
- `pin.required` defaults to `false`.
- Optional pin failures degrade and leave the sent message intact.
- Required pin failures fail delivery.
- Chunked messages pin the first delivered chunk, not the tail chunk.

Manual `pin`, `unpin`, and `pins` message actions still exist for existing
messages where the provider supports those operations.

## Plugin author checklist

- Declare `presentation` from `describeMessageTool(...)` when the channel can
  render or safely degrade semantic presentation.
- Add `presentationCapabilities` to the runtime outbound adapter.
- Implement `renderPresentation` in runtime code, not control-plane plugin
  setup code.
- Keep native UI libraries out of hot setup/catalog paths.
- Preserve platform limits in the renderer and tests.
- Add fallback tests for unsupported buttons, selects, URL buttons, title/text
  duplication, and mixed `message` plus `presentation` sends.
- Add delivery pin support through `deliveryCapabilities.pin` and
  `pinDeliveredMessage` only when the provider can pin the sent message id.
- Do not expose new provider-native card/block/component/button fields through
  the shared message action schema.

## Related docs

- [Message CLI](/cli/message)
- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Architecture](/plugins/architecture-internals#message-tool-schemas)
- [Channel Presentation Refactor Plan](/plan/ui-channels)
