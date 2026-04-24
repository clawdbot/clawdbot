---
summary: Decouple semantic message presentation from channel native UI renderers.
title: Channel presentation refactor plan
read_when:
  - Refactoring channel message UI, interactive payloads, or native channel renderers
  - Changing message tool capabilities, delivery hints, or cross-context markers
  - Debugging Discord Carbon import fanout or channel plugin runtime laziness
---

## Status

Implemented for the shared agent, CLI, plugin capability, and outbound delivery surfaces:

- `ReplyPayload.presentation` carries semantic message UI.
- `ReplyPayload.delivery.pin` carries sent-message pin requests.
- Shared message actions expose `presentation`, `delivery`, and `pin` instead of provider-native `components`, `blocks`, `buttons`, or `card`.
- Core renders or auto-degrades presentation through plugin-declared outbound capabilities.
- Discord, Slack, Telegram, Mattermost, MS Teams, and Feishu renderers consume the generic contract.
- Discord channel control-plane code no longer imports Carbon-backed UI containers.

Canonical docs now live in [Message Presentation](/plugins/message-presentation).
Keep this plan as historical implementation context; update the canonical guide
for contract, renderer, or fallback behavior changes.

## Problem

Channel UI is currently split across several incompatible surfaces:

- Core owns a Discord-shaped cross-context renderer hook through `buildCrossContextComponents`.
- Discord `channel.ts` can import native Carbon UI through `DiscordUiContainer`, which pulls runtime UI dependencies into the channel plugin control plane.
- The agent and CLI expose native payload escape hatches such as Discord `components`, Slack `blocks`, Telegram or Mattermost `buttons`, and Teams or Feishu `card`.
- `ReplyPayload.channelData` carries both transport hints and native UI envelopes.
- The generic `interactive` model exists, but it is narrower than the richer layouts already used by Discord, Slack, Teams, Feishu, LINE, Telegram, and Mattermost.

This makes core aware of native UI shapes, weakens plugin runtime laziness, and gives agents too many provider-specific ways to express the same message intent.

## Goals

- Core decides the best semantic presentation for a message from declared capabilities.
- Extensions declare capabilities and render semantic presentation into native transport payloads.
- Web Control UI remains separate from chat native UI.
- Native channel payloads are not exposed through the shared agent or CLI message surface.
- Unsupported presentation features auto-degrade to the best text representation.
- Delivery behavior such as pinning a sent message is generic delivery metadata, not presentation.

## Non Goals

- No backwards compatibility shim for `buildCrossContextComponents`.
- No public native escape hatches for `components`, `blocks`, `buttons`, or `card`.
- No core imports of channel-native UI libraries.
- No provider-specific SDK seams for bundled channels.

## Target Model

Add a core-owned `presentation` field to `ReplyPayload`.

```ts
type MessagePresentationTone = "neutral" | "info" | "success" | "warning" | "danger";

type MessagePresentation = {
  tone?: MessagePresentationTone;
  title?: string;
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
```

`interactive` becomes a subset of `presentation` during migration:

- `interactive` text block maps to `presentation.blocks[].type = "text"`.
- `interactive` buttons block maps to `presentation.blocks[].type = "buttons"`.
- `interactive` select block maps to `presentation.blocks[].type = "select"`.

The external agent and CLI schemas now use `presentation`; `interactive` remains an internal legacy parser/rendering helper for existing reply producers.

## Delivery Metadata

Add a core-owned `delivery` field for send behavior that is not UI.

```ts
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

Semantics:

- `delivery.pin = true` means pin the first successfully delivered message.
- `notify` defaults to `false`.
- `required` defaults to `false`; unsupported channels or failed pinning auto-degrade by continuing delivery.
- Manual `pin`, `unpin`, and `list-pins` message actions remain for existing messages.

Current Telegram ACP topic binding should move from `channelData.telegram.pin = true` to `delivery.pin = true`.

## Runtime Capability Contract

Add presentation and delivery render hooks to the runtime outbound adapter, not the control-plane channel plugin.

```ts
type ChannelPresentationCapabilities = {
  supported: boolean;
  buttons?: boolean;
  selects?: boolean;
  context?: boolean;
  divider?: boolean;
  tones?: MessagePresentationTone[];
};

type ChannelDeliveryCapabilities = {
  pinSentMessage?: boolean;
};

type ChannelOutboundAdapter = {
  presentationCapabilities?: ChannelPresentationCapabilities;

  renderPresentation?: (params: {
    payload: ReplyPayload;
    presentation: MessagePresentation;
    ctx: ChannelOutboundSendContext;
  }) => ReplyPayload | null;

  deliveryCapabilities?: ChannelDeliveryCapabilities;

  pinDeliveredMessage?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    to: string;
    threadId?: string | number | null;
    messageId: string;
    notify: boolean;
  }) => Promise<void>;
};
```

Core behavior:

- Resolve target channel and runtime adapter.
- Ask for presentation capabilities.
- Degrade unsupported blocks before rendering.
- Call `renderPresentation`.
- If no renderer exists, convert presentation to text fallback.
- After successful send, call `pinDeliveredMessage` when `delivery.pin` is requested and supported.

## Channel Mapping

Discord:

- Render `presentation` to components v2 and Carbon containers in runtime-only modules.
- Keep accent color helpers in light modules.
- Remove `DiscordUiContainer` imports from channel plugin control-plane code.

Slack:

- Render `presentation` to Block Kit.
- Remove agent and CLI `blocks` input.

Telegram:

- Render text, context, and dividers as text.
- Render actions and select as inline keyboards when configured and allowed for the target surface.
- Use text fallback when inline buttons are disabled.
- Move ACP topic pinning to `delivery.pin`.

Mattermost:

- Render actions as interactive buttons where configured.
- Render other blocks as text fallback.

MS Teams:

- Render `presentation` to Adaptive Cards.
- Keep manual pin/unpin/list-pins actions.
- Optionally implement `pinDeliveredMessage` if Graph support is reliable for the target conversation.

Feishu:

- Render `presentation` to interactive cards.
- Keep manual pin/unpin/list-pins actions.
- Optionally implement `pinDeliveredMessage` for sent-message pinning if API behavior is reliable.

LINE:

- Render `presentation` to Flex or template messages where possible.
- Fall back to text for unsupported blocks.
- Remove LINE UI payloads from `channelData`.

Plain or limited channels:

- Convert presentation to text with conservative formatting.

## Refactor Steps

1. Reapply the Discord release fix that splits `ui-colors.ts` from Carbon-backed UI and removes `DiscordUiContainer` from `extensions/discord/src/channel.ts`.
2. Add `presentation` and `delivery` to `ReplyPayload`, outbound payload normalization, delivery summaries, and hook payloads.
3. Add `MessagePresentation` schema and parser helpers in a narrow SDK/runtime subpath.
4. Replace message capabilities `buttons`, `cards`, `components`, and `blocks` with semantic presentation capabilities.
5. Add runtime outbound adapter hooks for presentation render and delivery pinning.
6. Replace cross-context component construction with `buildCrossContextPresentation`.
7. Delete `src/infra/outbound/channel-adapters.ts` and remove `buildCrossContextComponents` from channel plugin types.
8. Change `maybeApplyCrossContextMarker` to attach `presentation` instead of native params.
9. Update plugin-dispatch send paths to consume only semantic presentation and delivery metadata.
10. Remove agent and CLI native payload params: `components`, `blocks`, `buttons`, and `card`.
11. Remove SDK helpers that create native message-tool schemas, replacing them with presentation schema helpers.
12. Remove UI/native envelopes from `channelData`; keep only transport metadata until each remaining field is reviewed.
13. Migrate Discord, Slack, Telegram, Mattermost, MS Teams, Feishu, and LINE renderers.
14. Update docs for message CLI, channel pages, plugin SDK, and capability cookbook.
15. Run import fanout profiling for Discord and affected channel entrypoints.

Steps 1-11 and 13-14 are implemented in this refactor for the shared agent, CLI, plugin capability, and outbound adapter contracts. Step 12 remains a deeper internal cleanup pass for provider-private `channelData` transport envelopes. Step 15 remains follow-up validation if we want quantified import-fanout numbers beyond the type/test gate.

## Tests

Add or update:

- Presentation normalization tests.
- Presentation auto-degrade tests for unsupported blocks.
- Cross-context marker tests for plugin dispatch and core delivery paths.
- Channel render matrix tests for Discord, Slack, Telegram, Mattermost, MS Teams, Feishu, LINE, and text fallback.
- Message tool schema tests proving native fields are gone.
- CLI tests proving native flags are gone.
- Discord entrypoint import-laziness regression covering Carbon.
- Delivery pin tests covering Telegram and generic fallback.

## Open Questions

- Should `delivery.pin` be implemented for Discord, Slack, MS Teams, and Feishu in the first pass, or only Telegram first?
- Should `delivery` eventually absorb existing fields such as `replyToId`, `replyToCurrent`, `silent`, and `audioAsVoice`, or stay focused on post-send behaviors?
- Should presentation support images or file references directly, or should media remain separate from UI layout for now?

## Related

- [Channels overview](/channels)
- [Message presentation](/plugins/message-presentation)
