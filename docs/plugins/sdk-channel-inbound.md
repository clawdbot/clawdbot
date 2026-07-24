---
summary: "Inbound event helpers for channel plugins: context building, shared runner orchestration, session record, and prepared reply dispatch"
title: "Channel inbound API"
read_when:
  - You are building or refactoring a messaging channel plugin receive path
  - You need shared inbound context construction, session recording, or prepared reply dispatch
  - You are migrating old channel turn helpers to inbound/message APIs
---

Channel receive paths follow one flow:

```text
platform event -> inbound facts/context -> agent reply -> message delivery
```

Use `openclaw/plugin-sdk/channel-inbound` for inbound event normalization,
formatting, roots, and orchestration. Use
`openclaw/plugin-sdk/channel-outbound` for native send, receipt, durable
delivery, and live preview behavior.

## Core helpers

```ts
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  dispatchChannelInboundReply,
} from "openclaw/plugin-sdk/channel-inbound";
```

- `buildChannelInboundEventContext(...)`: projects normalized channel facts
  into the prompt/session context. Pass channel-owned sender/chat metadata
  through `channelContext`, which plugin hooks see as `ctx.channelContext`.
  Augment `PluginHookChannelSenderContext` or `PluginHookChannelChatContext`
  from this subpath for channel-specific fields.
- `runChannelInboundEvent(...)`: runs ingest, classify, preflight, resolve,
  record, dispatch, and finalize for one inbound platform event.
- `dispatchChannelInboundReply(...)`: records and dispatches an already
  assembled inbound reply with a delivery adapter.

For media-only inbound events, keep the message body and command text empty and
pass one `ChannelInboundMediaInput` fact per native attachment. When an ambient
history line or another text-only carrier must describe those facts, use
`formatMediaPlaceholderText(media)`. It classifies each fact from `kind`, MIME
type, then path or URL extension; undownloaded native attachments should still
contribute one type-only fact each. Do not use the formatter to synthesize the
primary inbound body.

Bundled/native channels that already receive the injected plugin runtime
object can call the same helpers under `runtime.channel.inbound.*` instead of
importing this subpath directly:

```ts
await runtime.channel.inbound.run({
  channel: "demo",
  accountId,
  raw: platformEvent,
  adapter: {
    ingest: normalizePlatformEvent,
    resolveTurn: resolveInboundReply,
  },
});
```

Assemble `dispatchChannelInboundReply(...)` inputs for compatibility
dispatchers that keep platform delivery in the delivery adapter. New send
paths should use message adapters and durable message helpers from
`channel-outbound` instead.

## Delivery settlement contract

`ChannelInboundTurnPlan.delivery` owns the native send for each logical reply
payload. Core owns outbound hook ordering and, when the adapter opts in,
terminal `message_sent` observation. Keep those responsibilities separate so
one payload cannot produce duplicate terminal events.

The delivery result fields have these meanings:

| Field                    | Contract                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`                | Provider-accepted visible text for the logical payload after native formatting or finalization. Omit it to use the prepared payload text for terminal observation. Media-only sends can omit it.                             |
| `messageIds` / `receipt` | Actual provider identities for the visible send. Prefer a `MessageReceipt`; core uses its primary provider id for `message_sent`.                                                                                            |
| `visibleReplySent`       | Set to `false` only when the provider produced no visible preview or final message. Core does not emit a successful `message_sent` for that result.                                                                          |
| `finalization`           | A promise for delayed native settlement of the same logical payload, such as closing or editing an in-place streaming card. Its resolved fields override the immediate result before terminal observation and `onDelivered`. |

Set the delivery adapter's `observeMessageSent` option to `true` when core
should emit the canonical plugin and internal `message_sent` events for this
adapter's non-durable sends. Do not return this option from `deliver`, and do
not emit those events in the plugin too. Durable sends already emit through
the shared outbound owner and are not duplicated.

Return one result per logical payload. `finalization` is not a second send and
must not rerun `reply_payload_sending` or `message_sending`. As soon as
`deliver` returns, core observes the finalization promise's rejection so it
cannot become unhandled; core still awaits the original promise after reply
dispatch settles. It then emits at most one terminal observation per payload
with the finalized content and provider id. `onDelivered`, when present,
receives the settled result after that observation.

Reject `deliver` or `finalization` when native delivery fails. If no provider
send was attempted, throw `PlatformMessageNotDispatchedError` from
`openclaw/plugin-sdk/error-runtime`; core suppresses a false `message_sent`
event. If a native send became visible before a later operation failed,
preserve the visible subset on the error:

```ts
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";

throw createChannelPartialDeliveryError(cause, {
  visibleReplySent: true,
  content: finalizedVisibleText,
  receipt,
});
```

Core emits a failed terminal observation with that provider-visible content and
identity, then keeps the delivery failed so callers do not mistake partial
success for a clean send. Do not report `visibleReplySent: false` after any
preview, draft, attachment, or final message became visible.

When `reply_payload_sending` or `message_sending` is registered, those hooks
must settle before anything provider-visible is created because either hook
can rewrite or cancel the logical payload. An eager native preview would leak
pre-rewrite content or leave a cancelled draft behind. Buffer preview content
until the accepted payload reaches `deliver`; compatibility dispatchers that
start previews earlier must suppress that eager preview while either hook is
registered. Use the finalizable live-preview helpers from
[Channel outbound API](/plugins/sdk-channel-outbound) for new preview paths.

## Migration

`runtime.channel.turn.*` runtime aliases were removed. Use:

- `runtime.channel.inbound.run(...)` for raw inbound events.
- `runtime.channel.inbound.dispatchReply(...)` for assembled reply contexts.
- `runtime.channel.inbound.buildContext(...)` for inbound context payloads.
- `runtime.channel.inbound.runPreparedReply(...)`, deprecated, only for
  channel-owned prepared dispatch paths that already assemble their own
  dispatch closure.

New plugin code should not introduce `turn`-named channel APIs. Keep model or
agent turn vocabulary inside agent/provider code; channel plugins use inbound,
message, delivery, and reply terms.
