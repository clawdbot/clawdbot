---
summary: "Status of the durable message receive/send lifecycle: what shipped, what changed from the original design, and what remains open"
read_when:
  - Refactoring channel send or receive behavior
  - Changing channel inbound, reply dispatch, outbound queue, preview streaming, or plugin SDK message APIs
  - Designing a new channel plugin that needs durable sends, receipts, previews, edits, or retries
title: "Message lifecycle refactor"
---

<Note>
This page originated as a forward-looking design proposal. The core of that
design has since shipped in `src/channels/message/*` and the public
`openclaw/plugin-sdk/channel-outbound` / `channel-inbound` subpaths. For the
current API, use [Channel outbound API](/plugins/sdk-channel-outbound) and
[Channel inbound API](/plugins/sdk-channel-inbound). This page tracks what
shipped, where the implementation diverged from the original sketch, and what
is still open.
</Note>

## Why this refactor happened

The channel stack grew from several local fixes: separate inbound helpers per
maturity level (`runtime.channel.inbound.run` for simple adapters,
`runtime.channel.inbound.runPreparedReply` for rich ones), legacy reply-dispatch
helpers (`dispatchInboundReplyWithBase`, `recordInboundSessionAndDispatchReply`),
channel-specific preview streaming, and final-delivery durability bolted onto
existing reply-payload paths. That shape produced too many public concepts and
too many places where delivery semantics could drift.

The reliability gap that forced the redesign:

```text
Telegram polling update acked
  -> assistant final text exists
  -> process restarts before sendMessage succeeds
  -> final response is lost
```

Target invariant: once core decides a visible outbound message should exist,
the send intent must be durable before the platform call is attempted, and the
platform receipt must be committed after success. That gives at-least-once
recovery by default. Exactly-once behavior only exists where an adapter proves
native idempotency or reconciles an unknown-after-send attempt against
platform state before replay.

## What shipped

The internal domain lives in `src/channels/message/*`:

| File                        | Owns                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `types.ts`                  | Adapter, send-context, receipt, and durable-intent type contracts                                                  |
| `send.ts`                   | `withDurableMessageSendContext` / `sendDurableMessageBatch` — the durable send context                             |
| `receive.ts`                | `createMessageReceiveContext` — inbound ack-policy state machine                                                   |
| `live.ts`                   | Live preview state and finalize-in-place-or-fall-back logic                                                        |
| `state.ts`                  | `classifyDurableSendRecoveryState` — recovery classification after interruption                                    |
| `receipt.ts`                | Normalizes platform send results into `MessageReceipt`                                                             |
| `capabilities.ts`           | Derives required durable-final capabilities from a payload                                                         |
| `contracts.ts`              | Contract-proof verification for declared adapter capabilities                                                      |
| `adapter.ts`                | `defineChannelMessageAdapter`                                                                                      |
| `outbound-bridge.ts`        | `createChannelMessageAdapterFromOutbound` — wraps legacy `sendText`/`sendMedia`/`sendPayload`/`sendPoll` functions |
| `ingress-queue.ts`          | `createChannelIngressQueue` — durable inbound event queue                                                          |
| `durable-receive.ts`        | `createDurableInboundReceiveJournal` — accept/pending/complete/release journal for inbound dedupe                  |
| `inbound-reply-dispatch.ts` | `dispatchChannelInboundReply` and legacy-named wrappers                                                            |
| `reply-pipeline.ts`         | `createChannelReplyPipeline`, reply-prefix and typing-callback helpers                                             |

Public surface: `openclaw/plugin-sdk/channel-outbound` (send/receipt/durable/live/reply-pipeline
helpers) and `openclaw/plugin-sdk/channel-inbound` (inbound context, `runChannelInboundEvent`,
`dispatchChannelInboundReply`). See those pages for adapter examples, current
type names, and migration notes — they are the source of truth for the API
shape, not the sketches below.

### Send context

`withDurableMessageSendContext` gives channel code `render`, `previewUpdate`,
`send`, `edit`, `delete`, `commit`, and `fail` steps around one outbound
message. `sendDurableMessageBatch` is the common-case wrapper: render, send,
then commit on `sent`/`suppressed` or fail on error.

`sendDurableMessageBatch` returns one discriminated result:

| Status           | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `sent`           | At least one visible platform message was delivered                              |
| `suppressed`     | No platform message should be treated as missing (hook-cancelled, dry-run, etc.) |
| `partial_failed` | At least one message delivered before a later payload or side effect failed      |
| `failed`         | No platform receipt was produced                                                 |

Durability is one of `required`, `best_effort`, or `disabled`
(`MessageDurabilityPolicy` in `src/channels/message/types.ts`). `required`
fails closed when the durable intent cannot be written; `best_effort` falls
through to a direct send when persistence is unavailable; `disabled` keeps the
pre-refactor direct-send behavior. Legacy compatibility helpers default to
`disabled` and do not infer `required` just because a channel has a generic
outbound adapter.

The boundary that stays dangerous: after the platform call succeeds and before
the receipt commits. If the process dies there, core cannot know whether the
platform message exists unless the adapter declares `reconcileUnknownSend`.
That hook classifies an interrupted send as `sent`, `not_sent`, or
`unresolved`; only `not_sent` permits replay. Channels without reconciliation
fall back to `unknown_after_send` state (`src/channels/message/state.ts`,
`src/infra/outbound/delivery-queue-recovery.ts`) and may choose at-least-once
replay only if duplicate visible messages are an acceptable, documented
tradeoff for that channel.

### Receive context

`createMessageReceiveContext` tracks ack/nack state per inbound event with an
idempotent `ack()` and explicit `nack(error)`. The ack policy
(`ChannelMessageReceiveAckPolicy`) is one of:

| Policy                 | Acks when                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `after_receive_record` | Core persisted enough inbound metadata to dedupe/route a redelivery                           |
| `after_agent_dispatch` | The agent run has been dispatched                                                             |
| `after_durable_send`   | The durable outbound send for this turn committed                                             |
| `manual`               | Caller controls ack timing explicitly (the default for adapters that do not declare a policy) |

Telegram polling uses this to persist a safe-completed update watermark
(`safeCompletedUpdateId` in `extensions/telegram/src/bot-update-tracker.ts`):
grammY still observes every update as it enters the middleware chain, but
OpenClaw only advances the persisted restart watermark past updates that
finished dispatch, so failed or still-pending updates replay after a restart.
Telegram's upstream `getUpdates` offset is still owned by grammY; a fully
durable polling source that controls platform-level redelivery beyond this
watermark is not built (see Open questions).

### Live preview

`src/channels/message/live.ts` models preview/edit/finalize as one lifecycle:
`createLiveMessageState`, `markLiveMessagePreviewUpdated`,
`markLiveMessageFinalized`, `markLiveMessageCancelled`, and
`deliverFinalizableLivePreviewAdapter` (build a final edit from a draft, apply
it, and fall back to a normal send when the edit is not possible or fails).
`LiveMessageState.phase` is `idle | previewing | finalizing | finalized |
cancelled`; `canFinalizeInPlace` gates whether a preview can become the final
message via edit instead of a fresh send.

### Durable receipts

`MessageReceipt` (`src/channels/message/types.ts`) normalizes one or more
platform message ids from a single logical send into `platformMessageIds` plus
per-part `parts` (kind, index, thread id, reply-to id). A primary id is kept
for threading and later edits. This is what makes multi-part deliveries (text
plus media, chunked text, card fallback) replayable and de-duplicatable after
a restart.

### Public SDK reduction

The refactor absorbed or deprecated: `reply-runtime`, `reply-dispatch-runtime`,
`reply-reference`, `reply-chunking`, `reply-payload` helpers exposed as public
API, `inbound-reply-dispatch`, `channel-reply-pipeline`, and most public uses
of the old outbound facade. `src/plugin-sdk/channel-message.ts` is now a
`@deprecated` re-export barrel pointing at `channel-outbound` /
`channel-inbound`; `channel.turn` runtime aliases were removed and the old
`/plugins/sdk-channel-turn` doc page redirects to
[Channel inbound API](/plugins/sdk-channel-inbound). New plugin code should
target `channel-outbound` and `channel-inbound` directly.

## Where the implementation diverged from the original design

The design sketch below never shipped as literally described. Record kept for
historical accuracy; do not treat these type names as current API.

- **No `MessageOrigin` / `shouldDropOpenClawEcho`.** The original plan called
  for a `source: "openclaw"` origin tag on gateway-failure messages plus a
  shared predicate that drops tagged bot-authored echoes in shared rooms
  before `allowBots` authorization. That type and predicate do not exist in
  the codebase. `allowBots` itself is a real per-channel config key (Slack,
  Discord, Google Chat, and others), but the origin-tagging mechanism that was
  meant to protect it was never built. Gateway-failure echo suppression in
  bot-enabled rooms remains an open gap, not a shipped guarantee.
- **No unified `core.messages.receive/send/live/state` namespace.** The
  shipped functions live directly in `src/channels/message/*`
  (`withDurableMessageSendContext`, `createMessageReceiveContext`,
  `createLiveMessageState`, `classifyDurableSendRecoveryState`) rather than
  behind a `core.messages.*` facade.
- **No generic `ChannelMessage` / `MessageTarget` / `MessageRelation`
  normalized message type.** Core still passes concrete reply payloads
  (`ReplyPayload`) and channel-specific contexts through the send adapters
  rather than one platform-neutral message shape with a `kind: "reply" |
"followup" | "broadcast" | "system"` relation.
- **Ack policy names differ from the sketch.** Shipped:
  `after_receive_record | after_agent_dispatch | after_durable_send | manual`.
  The original sketch used `immediate | after-record | after-durable-send |
manual` with a webhook-timeout reason field; that shape was not built.
- **`DurableFinalDeliveryRequirementMap` capability keys replaced the sketched
  `MessageCapabilities` object.** Capabilities are flat boolean flags (`text`,
  `media`, `poll`, `payload`, `silent`, `replyTo`, `thread`, `nativeQuote`,
  `messageSendingHooks`, `batch`, `reconcileUnknownSend`, `afterSendSuccess`,
  `afterCommit`) verified through `verifyDurableFinalCapabilityProofs` rather
  than a nested `text.chunking` / `attachments.voice` style structure.

## Concrete migration hazards (still relevant)

These channel-specific side effects predate the refactor and must keep
working through the new send paths. They are not hypothetical: each is
implemented and load-bearing today.

- **iMessage** (`extensions/imessage/src/monitor/echo-cache.ts`,
  `persisted-echo-cache.ts`): the monitor records sent messages in an echo
  cache after a successful send. Durable final sends must still populate that
  cache, or OpenClaw can re-ingest its own replies as inbound user messages.
- **Tlon** (`extensions/tlon/src/monitor/index.ts`): appends an optional model
  signature and records participated threads after group replies. Durable
  delivery must not bypass those effects.
- **Discord and other prepared dispatchers** already own direct delivery and
  preview behavior. A channel is not durable end-to-end until its prepared
  dispatcher explicitly routes finals through the send context; do not assume
  coverage from the generic adapter alone.
- **Telegram silent fallback delivery** must deliver the whole projected
  payload array, not just the first payload, after chunking/fallback
  projection.
- **LINE, Zalo, Nostr**, and similar helper paths can have reply-token
  handling, media proxying, sent-message caches, or callback-only targets.
  They stay on channel-owned delivery until those semantics are represented by
  the send adapter and covered by tests.
- **Direct-DM helpers** can have a reply callback that is the only correct
  transport target. Generic outbound must not guess a target from raw
  platform fields and skip that callback.

## Failure classification

Adapters classify transport failures into `DeliveryFailureKind`-style closed
categories (transient, rate limit, auth, permission, not found, invalid
payload, conflict, cancelled, unknown). Core policy:

- Retry transient and rate-limit failures.
- Do not retry invalid-payload failures unless a render fallback exists.
- Do not retry auth or permission failures until configuration changes.
- On not-found, let live finalization fall back from edit to a fresh send when
  the channel declares that safe.
- On conflict, use receipt/idempotency state to decide whether the message
  already exists.
- Any error after the platform call may have succeeded but before receipt
  commit becomes `unknown_after_send` unless the adapter proves the platform
  operation did not happen.

## Open questions

- Whether Telegram should eventually replace the grammY (`1.43.0`) polling
  runner with a fully durable polling source that controls platform-level
  redelivery, not only OpenClaw's persisted restart watermark
  (`safeCompletedUpdateId`).
- Whether live preview state should live in the same record as the final send
  intent or in a sibling live-state store.
- Whether gateway-failure echo suppression in shared bot-enabled rooms needs
  the originally planned origin-tagging mechanism, a simpler per-channel
  contract, or is out of scope.
- Which channels have native origin/metadata support for cross-bot echo
  suppression versus needing a persisted outbound registry.

## Related

- [Messages](/concepts/messages)
- [Streaming and chunking](/concepts/streaming)
- [Progress drafts](/concepts/progress-drafts)
- [Retry policy](/concepts/retry)
- [Channel outbound API](/plugins/sdk-channel-outbound)
- [Channel inbound API](/plugins/sdk-channel-inbound)
