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
