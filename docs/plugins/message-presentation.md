---
summary: "Semantic message cards, charts, controls, fallback text, and delivery hints for channel plugins"
title: "Message presentation"
read_when:
  - Adding or modifying message card, chart, button, or select rendering
  - Building a channel plugin that supports rich outbound messages
  - Changing message tool presentation or delivery capabilities
  - Debugging provider-specific card/block/component rendering regressions
---

Message presentation is OpenClaw's shared contract for rich outbound chat UI.
It lets agents, CLI commands, approval flows, and plugins describe the message
intent once, while each channel plugin renders the best native shape it can.

Use presentation for portable message UI: text sections, small context/footer
text, dividers, charts, buttons, select menus, and card title/tone.

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
  | { type: "select"; placeholder?: string; options: MessagePresentationOption[] }
  | {
      type: "chart";
      chartType: "pie";
      title: string;
      segments: Array<{ label: string; value: number }>;
    }
  | {
      type: "chart";
      chartType: "bar" | "area" | "line";
      title: string;
      categories: string[];
      series: Array<{ name: string; values: number[] }>;
      xLabel?: string;
      yLabel?: string;
    };

type MessagePresentationAction =
  | { type: "command"; command: string }
  | { type: "callback"; value: string };

type MessagePresentationButton = {
  label: string;
  action?: MessagePresentationAction;
  /** Legacy callback value. Prefer action for new controls. */
  value?: string;
  url?: string;
  webApp?: { url: string };
  /** @deprecated Use webApp. Accepted for legacy JSON payloads only. */
  web_app?: { url: string };
  priority?: number;
  disabled?: boolean;
  reusable?: boolean;
  style?: "primary" | "secondary" | "success" | "danger";
};

type MessagePresentationOption = {
  label: string;
  action?: MessagePresentationAction;
  /** Legacy callback value. Prefer action for new controls. */
  value?: string;
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

- `action.type: "command"` runs a native slash command through core's command
  path. Use this for built-in command buttons and menus.
- `action.type: "callback"` carries opaque plugin data through the channel's
  interaction path. Channel plugins must not reinterpret callback data as slash
  commands.
- `value` is the legacy opaque callback value. New controls should use `action`
  so channel plugins can map commands and callbacks without guessing from text.
- `url` is a link button. It can exist without `value`.
- `webApp` describes a channel-native web app button. Telegram renders this
  as `web_app` and only supports it in private chats. `web_app` is still
  accepted in loose JSON payloads for compatibility, but TypeScript producers
  should use `webApp`.
- `label` is required and is also used in text fallback.
- `style` is advisory. Renderers should map unsupported styles to a safe
  default, not fail the send.
- `priority` is optional. When a channel advertises action limits and controls
  must be dropped, core keeps higher-priority buttons first and preserves
  original order among equal priority buttons. When all controls fit, authored
  order is preserved.
- `disabled` is optional. Channels must opt in with `supportsDisabled`; otherwise
  core degrades the disabled control to non-interactive fallback text. A
  disabled button always renders label-only in fallback text, even when it
  carries a `command` action.
- `reusable` is optional. Channels that support reusable native callbacks may
  keep the action available after a successful interaction. Use it for
  repeatable or idempotent actions such as refresh, inspect, or more details;
  leave it unset for normal one-shot approvals and destructive actions.

Select semantics:

- `options[].action` has the same command/callback meaning as button `action`.
- `options[].value` is the legacy selected application value.
- `placeholder` is advisory and may be ignored by channels without native
  select support.
- If a channel does not support selects, fallback text lists the labels.

Chart semantics:

- `pie` requires positive segment values.
- `bar`, `area`, and `line` use one ordered `categories` array. Every series
  supplies exactly one finite value per category, in the same order.
- Category labels and series names must be unique. Invalid or incomplete chart
  blocks are dropped during normalization rather than silently changing data.
- Native chart rendering is opt-in through `presentationCapabilities.charts`.
  Other channels receive the chart title, axes, categories, series, and values
  as deterministic text. This is also the accessibility fallback.

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

Telegram Mini App button:

```json
{
  "blocks": [
    {
      "type": "buttons",
      "buttons": [{ "label": "Launch", "web_app": { "url": "https://example.com/app" } }]
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

Chart:

```json
{
  "blocks": [
    {
      "type": "chart",
      "chartType": "line",
      "title": "Quarterly revenue",
      "categories": ["Q1", "Q2", "Q3"],
      "series": [
        { "name": "Product", "values": [120, 145, 138] },
        { "name": "Services", "values": [80, 95, 104] }
      ],
      "xLabel": "Quarter",
      "yLabel": "Revenue"
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
    charts: false,
    limits: {
      actions: {
        maxActions: 25,
        maxActionsPerRow: 5,
        maxRows: 5,
        maxLabelLength: 80,
        maxValueBytes: 100,
        supportsStyles: true,
        supportsDisabled: false,
      },
      selects: {
        maxOptions: 25,
        maxLabelLength: 100,
        maxValueBytes: 100,
      },
      text: {
        maxLength: 2000,
        encoding: "characters",
        markdownDialect: "discord-markdown",
      },
    },
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

Capability booleans describe what the renderer can make interactive. Optional
`limits` describe the generic envelope core can adapt before calling the
renderer:

```ts
type ChannelPresentationCapabilities = {
  supported?: boolean;
  buttons?: boolean;
  selects?: boolean;
  context?: boolean;
  divider?: boolean;
  charts?: boolean;
  limits?: {
    actions?: {
      maxActions?: number;
      maxActionsPerRow?: number;
      maxRows?: number;
      maxLabelLength?: number;
      maxValueBytes?: number;
      supportsStyles?: boolean;
      supportsDisabled?: boolean;
      supportsLayoutHints?: boolean;
    };
    selects?: {
      maxOptions?: number;
      maxLabelLength?: number;
      maxValueBytes?: number;
    };
    text?: {
      maxLength?: number;
      encoding?: "characters" | "utf8-bytes" | "utf16-units";
      markdownDialect?: "plain" | "markdown" | "html" | "slack-mrkdwn" | "discord-markdown";
      supportsEdit?: boolean;
    };
  };
};
```

Core applies generic limits to semantic controls before rendering. Renderers
still own final provider-specific validation and clipping for native block
count, card size, URL limits, and provider quirks that cannot be expressed in
the generic contract. If limits remove every control from a block, core keeps
the labels as non-interactive context text so the delivered message still has a
visible fallback.

## Core render flow

On the canonical outbound path used by CLI and standard message actions, core:

1. Normalizes the presentation payload.
2. Resolves the target channel's outbound adapter.
3. Reads `presentationCapabilities`.
4. Applies generic capability limits such as action count, label length, and
   select option count when the adapter advertises them. Chart blocks become
   deterministic text unless the adapter explicitly advertises `charts: true`.
5. Calls `renderPresentation` when the adapter can render the payload.
6. Falls back to conservative text when the adapter is absent or cannot render.
7. Sends the resulting payload through the normal channel delivery path.
8. Applies delivery metadata such as `delivery.pin` after the first successful
   sent message.

Channel-local reply or preview funnels that consume `ReplyPayload` directly
must either enter that canonical path or materialize the same presentation
fallback before projecting the payload down to plain text/media.

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
- chart title, type, axes, categories, series, and values

### Button value fallback visibility

When a channel cannot render interactive controls, button and select values
fall back to plain text. The fallback behavior preserves usability while
keeping opaque callback data private:

- **`command`-typed actions** render as `label: \`command\`` so users can
  copy the command and run it manually in the channel input.
- **`callback`-typed actions** and legacy **`value`** fields render as
  label-only. The opaque callback value is not exposed in fallback text.
- **`url` / `webApp`** buttons render the URL text alongside the button
  label, since the URL is user-facing.
- **Select options** render as label-only. The underlying option value is not
  exposed in fallback text.

Channel adapters that add manual-command guidance in their fallback UI (e.g.
Feishu document-comment instructions) must derive the command-present check
from the same presentation blocks that the fallback renderer uses, so the
guidance text only appears when a manual command is actually shown.

Unsupported native controls should degrade rather than fail the whole send.
Examples:

- Telegram with inline buttons disabled sends text fallback.
- A channel without select support lists select options as text.
- A channel without native chart support lists the chart data as text.
- A URL-only button becomes either a native link button or a fallback URL line.
- Optional pin failures do not fail the delivered message.

The main exception is `delivery.pin.required: true`; if pinning is requested as
required and the channel cannot pin the sent message, delivery reports failure.

## Provider mapping

Current bundled renderers:

| Channel         | Native render target                      | Notes                                                                                                                                                                                                             |
| --------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord         | Components and component containers       | Preserves legacy `channelData.discord.components` for existing provider-native payload producers, but new shared sends should use `presentation`.                                                                 |
| Feishu          | Interactive cards                         | Card header can use `title`; body avoids duplicating that title.                                                                                                                                                  |
| Matrix          | Text fallback plus structured event field | Buttons/selects advertise as supported, but every block currently renders as `renderMessagePresentationFallbackText` output carried in a `com.openclaw.presentation` event field, not native interactive widgets. |
| Mattermost      | Text plus interactive props               | Selects and dividers are not supported; those blocks degrade to text.                                                                                                                                             |
| Microsoft Teams | Adaptive Cards                            | Plain `message` text is included with the card when both are provided. Selects, styles, and disabled state are not supported.                                                                                     |
| Slack           | Block Kit                                 | Renders `chart` as native `data_visualization`; preserves legacy `channelData.slack.blocks`, but new shared sends should use `presentation`.                                                                      |
| Telegram        | Text plus inline keyboards                | Buttons/selects require inline button capability for the target surface; otherwise text fallback is used.                                                                                                         |
| Plain channels  | Text fallback                             | Channels without a renderer still get readable output.                                                                                                                                                            |

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
- chart
- URL-only buttons
- generic delivery metadata through `ReplyPayload.delivery`

Use helpers from `openclaw/plugin-sdk/interactive-runtime` when bridging older
code:

```ts
import {
  adaptMessagePresentationForChannel,
  applyPresentationActionLimits,
  hasMessagePresentationBlocks,
  interactiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  presentationPageSize,
  presentationToInteractiveControlsReply,
  presentationToInteractiveReply,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationActionValue,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
```

New code should accept or produce `MessagePresentation` directly. Existing
`interactive` payloads are a deprecated subset of `presentation`; runtime
support remains for older producers.

Non-deprecated helpers worth knowing:

- `normalizeMessagePresentation(raw)` / `hasMessagePresentationBlocks(value)`
  validate and coerce an untyped payload (for example, JSON from the CLI
  `--presentation` flag) into `MessagePresentation`.
- `isMessagePresentationInteractiveBlock(block)` narrows a block to the
  `buttons` | `select` union.
- `resolveMessagePresentationActionValue(action)` /
  `resolveMessagePresentationControlValue(control)` read the effective
  command/callback value off an `action`, falling back to the legacy `value`
  field for `resolveMessagePresentationControlValue`.

The legacy `InteractiveReply*` types and conversion helpers are marked
`@deprecated` in the SDK:

- `InteractiveReply`, `InteractiveReplyBlock`, `InteractiveReplyButton`,
  `InteractiveReplyOption`, `InteractiveReplySelectBlock`, and
  `InteractiveReplyTextBlock`
- `normalizeInteractiveReply(...)`
- `hasInteractiveReplyBlocks(...)`
- `interactiveReplyToPresentation(...)`
- `presentationToInteractiveReply(...)`
- `presentationToInteractiveControlsReply(...)`
- `resolveInteractiveTextFallback(...)`
- `reduceInteractiveReply(...)`

`presentationToInteractiveReply(...)` and
`presentationToInteractiveControlsReply(...)` remain available as renderer
bridges for legacy channel implementations. New producer code should not call
them; send `presentation` and let core/channel adaptation handle rendering.

Approval helpers also have presentation-first replacements:

- use `buildApprovalPresentationFromActionDescriptors(...)` instead of
  `buildApprovalInteractiveReplyFromActionDescriptors(...)`
- use `buildApprovalPresentation(...)` instead of
  `buildApprovalInteractiveReply(...)`
- use `buildExecApprovalPresentation(...)` instead of
  `buildExecApprovalInteractiveReply(...)`

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
- Declare generic capability limits on `presentationCapabilities.limits` when
  they are known.
- Preserve final platform limits in the renderer and tests.
- Add fallback tests for unsupported charts, buttons, selects, URL buttons,
  title/text duplication, and mixed `message` plus `presentation` sends.
- Add delivery pin support through `deliveryCapabilities.pin` and
  `pinDeliveredMessage` only when the provider can pin the sent message id.
- Do not expose new provider-native card/block/component/button fields through
  the shared message action schema.

## Related docs

- [Message CLI](/cli/message)
- [Plugin SDK Overview](/plugins/sdk-overview)
- [Plugin Architecture](/plugins/architecture-internals#message-tool-schemas)
- [Channel Presentation Refactor Plan](/plan/ui-channels)
