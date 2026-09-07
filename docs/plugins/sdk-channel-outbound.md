---
summary: "Outbound message lifecycle API for channel plugins: adapters, receipts, durable sends, live preview, and reply pipeline helpers"
title: "Channel outbound API"
doc-schema-version: 1
read_when:
  - You are building or refactoring a messaging channel plugin send path
  - You need durable final reply delivery, receipts, live preview finalization, or receive acknowledgement policy
  - You are migrating from channel-message or legacy reply dispatch helpers
---

Channel plugins expose outbound message behavior from
`openclaw/plugin-sdk/channel-outbound`. Use
`openclaw/plugin-sdk/channel-inbound` for receive/context/dispatch
orchestration.

Core owns queueing, durability, the durable **ingress monitor and drain**
(`createChannelIngressMonitor`, `createChannelIngressDrain`, and
`openChannelIngressDrain`), generic retry policy, turn-adoption lifecycle
(`turnAdoptionLifecycle` / `bindIngressLifecycleToReplyOptions`), hooks,
receipts, and the shared `message` tool. The plugin owns native
send/edit/delete calls, target normalization, platform threading, selected
quotes, notification flags, account state, ingress inspection and payload
encoding, lane keys, non-retryable predicates, optional supersede
authorization, and platform-specific side effects.

## Durable ingress monitors

Use `createChannelIngressMonitor(...)` when a channel must persist accepted
transport events before dispatch. It composes a channel ingress queue and drain
with the shared admission, polling, pruning, delivery, and shutdown lifecycle.
Use the lower-level `createChannelIngressDrain(...)` only when the transport
owns a materially different admission or pump contract.

The required options are:

| Option                           | Contract                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue`                          | A `ChannelIngressQueue`, or a lazy factory that opens the account-scoped queue.                                                                                                                                                                                                                                  |
| `inspect(raw, context)`          | Returns the stable `eventId` and serialized `laneKey`, or `null` for an ignored event. Claim-time facts must match the persisted id and lane.                                                                                                                                                                    |
| `payload`                        | Supplies the payload version plus body serialization/deserialization. Use `storage: "raw-event"` for the standard `{ version, rawEvent }` string envelope, or provide custom encode/decode callbacks for an existing channel-specific shape. `createClaimError` classifies invalid versions or changed identity. |
| `deliver(raw, lifecycle, claim)` | Dispatches one decoded event and receives the complete adoption lifecycle. It may return `completed`, `deferred`, `failed-retryable`, or nothing.                                                                                                                                                                |
| `pollIntervalMs`                 | Schedules recovery/drain polls while the monitor is running.                                                                                                                                                                                                                                                     |
| `retention`                      | Supplies the prune cadence and completed/failed TTL and entry caps.                                                                                                                                                                                                                                              |

The monitor serializes admissions so append backoff cannot invert a lane. The
default bounded append delays are `0`, `100`, and `300` ms; exhaustion rejects
the transport callback instead of dispatching an event that was not made
durable. At claim time it decodes the versioned payload, re-runs `inspect`, and
rejects an id or lane mismatch before delivery.

`onDurableAdmission(raw, context)` runs after every durable enqueue, including
duplicates. `context.isNew` is `true` if and only if this admission inserted the
`(queue_name, event_id)` row. It does not indicate claim ownership or eventual
delivery. If retention previously pruned the row, a later admission may insert
it again and report `isNew: true`.

`deliver` receives `onAdopted`, `onDeferred`, `onAdoptionFinalizing`, `onFailed`,
`onCancelled`, `onAbandoned`, and `abortSignal`. Use `onFailed` for delivery
errors, `onCancelled` for explicit pre-adoption cancellation that must preserve
retry accounting, and `onAbandoned` when a non-adopted turn should consume a
retry attempt. Returning without an explicit handoff marks a terminal
no-dispatch event adopted. `admission` is always `exclusive`. A deferred handoff
keeps the claim held, while shutdown or abort leaves unadopted work retryable.
The monitor tracks delivery independently from claim settlement because
adoption can tombstone a row before the channel's delivery promise returns.

Optional settings include custom append delays, a `drain` option block for
advanced drain ordering/concurrency/retry policy, an external `abortSignal`, a
clock, pump error reporting, a stopped-error factory, and admission policy.
The returned monitor exposes `admit`, `ensureQueueAvailable`, `start`, `pause`,
`stop`, `waitForIdle`, `isRunning`, and `isStopped`. Use the idempotent
`ensureQueueAvailable()` check when plugin-owned migration or preparation must
run after the queue opens but before the drain starts. `stop` first settles
accepted admissions, then aborts and disposes the drain, waits for the pump and
active deliveries, and disposes again to close the lazy-creation race.

Keep transport-specific redaction, raw-envelope validation, non-retryable
classification, and persisted payload shape in the plugin. Webhook transports
should acknowledge only after `admit` resolves; non-replay transports should
surface durable append exhaustion rather than silently dispatching.

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

Only declare capabilities the native transport actually preserves. Cover
each declared send, receipt, live-preview, and receive-ack capability with
the contract helpers exported from this subpath.

## Outbound echo suppression

When a platform may redeliver the plugin's own outbound message as inbound, call `recordOutboundMessageIdentity(...)` with the channel, account, conversation, and a stable platform message or source identity. The shared inbound turn path drops matching identities for a bounded 30-second window before session recording or agent dispatch; a source identity may be reserved before send or refreshed when a channel route is removed to close delivery races. `isRecentOutboundMessageIdentity(...)` exposes the same query for channel diagnostics and tests. Do not maintain a parallel channel-local TTL cache for the same stable identity.

## Plain-text sanitization

Use `sanitizeForPlainText(...)` when an outbound adapter needs to convert the
supported HTML formatting tags into lightweight text markup. The default keeps
the existing chat-style bold and strikethrough markers. Pass
`{ style: "markdown" }` only when the channel reparses the result as Markdown:

```ts
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";

const chatText = sanitizeForPlainText(text);
const markdownText = sanitizeForPlainText(text, { style: "markdown" });
```

The Markdown style uses `**bold**` and `~~strikethrough~~`; italic and inline
code keep `_italic_` and backtick markers in both styles. Select the style at
the channel boundary instead of rewriting marker text after sanitization.

## Delivery Evidence

A `MessageReceipt` records the result returned by a channel adapter. Concrete
platform message identifiers show that the platform send path accepted the
message; they do not prove that a recipient's device displayed or read it.
Destination and routing identifiers such as chat, channel, room, conversation,
or recipient JID are metadata, never `platformMessageIds`. Receipts without
platform message identifiers are local receipt metadata only. A
provider-observed receipt thread overrides the requested route thread. If a
batch contains conflicting provider threads, each part retains its thread and
the aggregate receipt omits `threadId`. Channels with read receipts or
device-delivery state should track those facts through a separate
channel-specific path.

When an adapter intentionally omits a send before dispatch, return
`outcome: "not_sent"` with an empty receipt and no message ID (legacy outbound
adapters use an empty `messageId`). Core records `adapter_returned_no_send` as
an intentional suppression, counts no physical send, and skips send-success
and commit hooks. Do not use this outcome for an acknowledged send without a
platform ID or for an unknown result after dispatch. An empty receipt alone
does not distinguish those states; existing acknowledgement behavior is
unchanged when `outcome` is omitted.

If a channel adapter can prove that retrying a failure cannot duplicate a
recipient-visible send and no finalization-capable call began, throw
`new PlatformMessageNotDispatchedError("...", { cause: error })` from
`openclaw/plugin-sdk/error-runtime`. Core can then clear stale send-attempt
evidence and safely retry the queued intent. Only the adapter that owns the
final dispatch boundary may make this assertion. Never use the marker after a
finalization/send call begins or returns an ambiguous result; false marking can
duplicate messages.

## Existing outbound adapters

If the channel already has a compatible `outbound` adapter, derive the
message adapter instead of duplicating send code:

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

Deriving an adapter does not make a channel-owned prepared dispatcher durable.
Route its final sends through the durable helpers while preserving
channel-specific post-send effects and callback-only transport targets.
`message.send.lifecycle.afterSendSuccess` runs after the native send succeeds;
for queued sends, `afterCommit` runs after queue acknowledgment. Keep effects
at the boundary they require rather than leaving them only in a legacy dispatcher.

## Durable sends

Runtime send helpers also live on `channel-outbound`:

- `sendDurableMessageBatch(...)`
- `withDurableMessageSendContext(...)`
- `deliverInboundReplyWithMessageSendContext(...)`
- draft streaming/progress helpers such as `resolveChannelDraftStreamingChunking(...)`

`sendDurableMessageBatch(...)` and `withDurableMessageSendContext(...)` default
to `durability: "required"`: failure to persist the send intent stops delivery
before the platform call. With `durability: "best_effort"`, a queue-write
failure can fall through to a logged, live-only send without crash recovery.
These durable helpers do not accept `durability: "disabled"`.

`sendDurableMessageBatch(...)` returns one explicit outcome:

| Outcome          | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| `sent`           | at least one visible platform message was accepted by the platform send path            |
| `suppressed`     | no platform message should be treated as missing                                        |
| `partial_failed` | at least one platform message was accepted before a later payload or side effect failed |
| `failed`         | no platform receipt was produced                                                        |

Use `payloadOutcomes` when a batch mixes sent, suppressed, and failed
payloads. Do not infer hook cancellation from an empty legacy
direct-delivery result.

Failure is not permission to send the same payload through another path.
Once admitted, the queue owns retry or reconciliation until its exact owner
acknowledges or terminally retires the intent. Pending custody is not a
delivery receipt: preserve partial receipts, and do not report an unconfirmed
`ask_user` prompt as visible. Gateway `OUTBOUND_DELIVERY_QUEUED` responses mean
delivery is pending and must not be resent; an ambiguous send may need
reconciliation rather than an automatic retry.

When a transport creates a thread during its first successful send, the
outbound adapter may implement `adoptTargetFromDelivery(...)`. Return the
typed thread ID from the platform receipt and core carries it into later
payloads, pins, and post-delivery hooks in that durable batch. Core never
replaces an explicit caller thread, and it does not infer adoption from
`receipt.threadId` without the adapter opt-in.

### Automatic unknown-send reconciliation

Set `message.durableFinal.automaticUnknownSendReconciliation` only when the
plugin can reconcile an ambiguous provider send from persisted, post-policy
state without rerunning modifying hooks or regenerating provider payloads.
Core considers this opt-in after hooks and cancellation, and only for exactly
one accepted prepared payload. Multi-payload batches do not opt in
automatically.

The adapter must also advertise `capabilities.reconcileUnknownSend: true` and
provide `reconcileUnknownSend(...)`. Use `reconcileUnknownSendKinds` to name
the concrete transport branches the plugin can prove, such as `text` or
`media`. If the kind map is present, the selected branch must be `true`.
Omitting the map means the callback claims every selected branch, so prefer an
explicit map for new plugins.

The callback must use provider-owned idempotency or authoritative readback to
return `sent` with the actual provider receipt, `not_sent` only when a fresh
send is provably safe, or `unresolved` when neither outcome can be proven.
When reconciliation is explicitly required, unsupported prepared shapes fail
before provider I/O. During recovery, missing, incomplete, or mismatched
provider proof must fail closed rather than replaying content that could
already be visible.

If reconciliation needs provider-owned persisted evidence, implement
`afterUnknownSendTerminal(...)`. Core calls it after the ambiguous queue row
has authoritatively moved to failed, including retry-budget exhaustion. Use it
to remove provider-owned plans or payloads that are no longer needed. Cleanup
is best effort and must be idempotent; a failure is logged without making the
terminal queue row replayable again.

## Deferred delivery admission

Use `message.durableFinal.admitDeferredDelivery(...)` when a resolved account
cannot safely accept core-managed outbound or deferred delivery. Core calls
this hook synchronously before live outbound work, including paths that skip
queue persistence, and again before replaying a recovered intent. The context
includes `cfg`, `channel`, `to`, `accountId`, and a `phase` of `live` or
`recovery`.

Return `{ status: "allowed" }` to continue. Return
`{ status: "permanent_rejection", reason }` when the delivery must not be
persisted, sent directly, or replayed. A live rejection fails before queue
creation, message hooks, or platform work. A recovery rejection marks the
queued record failed and skips reconciliation and replay. Omitting the hook
means allowed.

The hook is a synchronous admission decision, not a send path. Read only
already-loaded config or runtime state; do not perform network, filesystem, or
other asynchronous I/O. Contract tests should exercise both phases and both
result variants through `ChannelMessageDurableFinalAdapter` from
`openclaw/plugin-sdk/channel-outbound`.

## Compatibility dispatch

Assemble inbound reply dispatch through `dispatchChannelInboundReply(...)`
from `channel-inbound`. Keep platform delivery in the delivery adapter; use
`channel-outbound` for message adapters, durable sends, receipts, live
preview, and reply pipeline options.

### Migrating from channel-message

`openclaw/plugin-sdk/channel-message` is a deprecated compatibility entrypoint.
It still re-exports `channel-outbound` and preserves three dispatch aliases.
Migrate those aliases to `openclaw/plugin-sdk/channel-inbound`:

| Deprecated alias                   | Replacement                         |
| ---------------------------------- | ----------------------------------- |
| `hasFinalChannelTurnDispatch`      | `hasFinalInboundReplyDispatch`      |
| `hasVisibleChannelTurnDispatch`    | `hasVisibleInboundReplyDispatch`    |
| `resolveChannelTurnDispatchCounts` | `resolveInboundReplyDispatchCounts` |

Follow the dated removal-eligibility window in [Migration](/plugins/sdk-migration).
This subpath is not tied to the next Plugin SDK major, and eligibility does not
itself remove an export. External imports do not emit a runtime warning; update
plugin imports rather than waiting for one.
