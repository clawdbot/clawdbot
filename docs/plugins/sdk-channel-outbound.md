---
summary: "Outbound message lifecycle API for channel plugins: adapters, receipts, durable sends, live preview, and reply pipeline helpers"
title: "Channel outbound API"
read_when:
  - You are building or refactoring a messaging channel plugin send path
  - You need durable final reply delivery, receipts, live preview finalization, or receive acknowledgement policy
  - You are migrating from channel-message, channel-message-runtime, or legacy reply dispatch helpers
---

Channel plugins should expose outbound message behavior from
`openclaw/plugin-sdk/channel-outbound`. Use
`openclaw/plugin-sdk/channel-inbound` for receive/context/dispatch orchestration.

Core owns queueing, durability, generic retry policy, hooks, receipts, and the
shared `message` tool. The plugin owns native send/edit/delete calls, target
normalization, platform threading, selected quotes, notification flags, account
state, and platform-specific side effects.

## Adapter

Most plugins define one `message` adapter:

```ts
import {
  defineChannelMessageAdapter,
  createMessageReceiptFromOutboundResults,
} from "openclaw/plugin-sdk/channel-outbound";

export const demoMessageAdapter = defineChannelMessageAdapter({
  id: "demo",
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async ({ cfg, to, text, accountId, replyToId, threadId, signal }) => {
      const sent = await sendDemoMessage({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
        threadId: threadId == null ? undefined : String(threadId),
        signal,
      });

      return {
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "demo", messageId: sent.id, conversationId: to }],
          kind: "text",
          threadId: threadId == null ? undefined : String(threadId),
          replyToId: replyToId ?? undefined,
        }),
      };
    },
  },
});
```

Only declare capabilities the native transport actually preserves. Cover each
declared send, receipt, live-preview, and receive-ack capability with the
contract helpers exported from this subpath.

## Existing Outbound Adapters

If the channel already has a compatible `outbound` adapter, derive the message
adapter instead of duplicating send code:

```ts
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";

export const messageAdapter = createChannelMessageAdapterFromOutbound({
  id: "demo",
  outbound,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
    },
  },
});
```

## Durable Sends

Runtime send helpers also live on `channel-outbound`:

- `sendDurableMessageBatch(...)`
- `withDurableMessageSendContext(...)`
- `deliverInboundReplyWithMessageSendContext(...)`
- draft streaming/progress helpers such as `resolveChannelStreamingPreviewChunk(...)`

`sendDurableMessageBatch(...)` returns one explicit outcome:

- `sent`: at least one visible platform message was delivered.
- `suppressed`: no platform message should be treated as missing.
- `partial_failed`: at least one platform message was delivered before a later
  payload or side effect failed.
- `failed`: no platform receipt was produced.

Use `payloadOutcomes` when a batch mixes sent, suppressed, and failed payloads.
Do not infer hook cancellation from an empty legacy direct-delivery result.

## Compatibility Dispatch

Inbound reply dispatch should be assembled through
`dispatchChannelInboundReply(...)` from `channel-inbound`. Keep platform
delivery in the delivery adapter; use `channel-outbound` for message adapters,
durable sends, receipts, live preview, and reply pipeline options.
