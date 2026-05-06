---
summary: "Design plan for the unified durable message receive, send, preview, edit, and streaming lifecycle"
read_when:
  - Refactoring channel send or receive behavior
  - Changing channel turn, reply dispatch, outbound queue, preview streaming, or plugin SDK message APIs
  - Designing a new channel plugin that needs durable sends, receipts, previews, edits, or retries
title: "Message lifecycle refactor"
---

This page is the target design for replacing scattered channel turn, reply
dispatch, preview streaming, and outbound delivery helpers with one durable
message lifecycle.

The short version:

- The core primitives should be **receive** and **send**, not **reply**.
- A reply is only a relation on an outbound message.
- A turn is an inbound-processing convenience, not the owner of delivery.
- Sending must be context based: `begin`, render, preview or stream, final send,
  commit, fail.
- Receiving must be context based too: normalize, dedupe, route, record,
  dispatch, platform ack, fail.
- The public plugin SDK should collapse to one small channel-message surface.

## Problems

The current channel stack grew from several valid local needs:

- Simple inbound adapters use `runtime.channel.turn.run`.
- Rich adapters use `runtime.channel.turn.runPrepared`.
- Legacy helpers use `dispatchInboundReplyWithBase`,
  `recordInboundSessionAndDispatchReply`, reply payload helpers, reply chunking,
  reply references, and outbound runtime helpers.
- Preview streaming lives in channel-specific dispatchers.
- Final delivery durability is being added around existing reply payload paths.

That shape fixes local bugs, but it leaves OpenClaw with too many public
concepts and too many places where delivery semantics can drift.

The reliability issue that exposed this is:

```text
Telegram polling update acked
  -> assistant final text exists
  -> process restarts before sendMessage succeeds
  -> final response is lost
```

The target invariant is broader than Telegram: once core decides a visible
outbound message should exist, the intent must be durable before the platform
send is attempted, and the platform receipt must be committed after success.
That gives OpenClaw at-least-once recovery. Exactly-once behavior exists only
for adapters that can prove native idempotency or reconcile an
unknown-after-send attempt against platform state before replay.

That is the end state for this refactor, not a description of every current
path. During migration, existing outbound helpers can still fall through to a
direct send when best-effort queue writes fail. The refactor is complete only
when durable final sends fail closed or explicitly opt out with a documented
non-durable policy.

## Goals

- One core lifecycle for all channel message receive and send paths.
- Durable final sends by default in the new message lifecycle after an adapter
  declares replay-safe behavior.
- Shared preview, edit, stream, finalization, retry, recovery, and receipt
  semantics.
- A small plugin SDK surface that third-party plugins can learn and maintain.
- Compatibility for existing `channel.turn` callers during migration.
- Clear extension points for new channel capabilities.
- No platform-specific branches in core.
- No token-delta channel messages. Channel streaming remains message preview,
  edit, append, or completed block delivery.
- Structured OpenClaw-origin metadata for operational/system output so visible
  gateway failures do not re-enter shared bot-enabled rooms as fresh prompts.

## Non goals

- Do not remove `runtime.channel.turn.*` in the first phase.
- Do not force every channel into the same native transport behavior.
- Do not teach core Telegram topics, Slack native streams, Matrix redactions,
  Feishu cards, QQ voice, or Teams activities.
- Do not publish all internal migration helpers as stable SDK API.
- Do not make retries replay completed non-idempotent platform operations.

## Reference model

Vercel Chat has a good public mental model:

- `Chat`
- `Thread`
- `Channel`
- `Message`
- adapter methods such as `postMessage`, `editMessage`, `deleteMessage`,
  `stream`, `startTyping`, and history fetches
- a state adapter for dedupe, locks, queues, and persistence

OpenClaw should borrow the vocabulary, not copy the surface.

What OpenClaw needs beyond that model:

- Durable outbound send intents before direct transport calls.
- Explicit send contexts with begin, commit, and fail.
- Receive contexts that know platform ack policy.
- Receipts that survive restart and can drive edits, deletes, recovery, and
  duplicate suppression.
- A smaller public SDK. Bundled plugins can use internal runtime helpers, but
  third-party plugins should see one coherent message API.
- Agent-specific behavior: sessions, transcripts, block streaming, tool
  progress, approvals, media directives, silent replies, and group mention
  history.

`thread.post()` style promises are not enough for OpenClaw. They hide the
transaction boundary that decides whether a send is recoverable.

## Core model

The new domain should live under an internal core namespace such as
`src/channels/message/*`.

It has four concepts:

```typescript
core.messages.receive(...)
core.messages.send(...)
core.messages.live(...)
core.messages.state(...)
```

`receive` owns inbound lifecycle.

`send` owns outbound lifecycle.

`live` owns preview, edit, progress, and stream state.

`state` owns durable intent storage, receipts, idempotency, recovery, locks, and
dedupe.

## Message terms

### Message

A normalized message is platform-neutral:

```typescript
type ChannelMessage = {
  id: string;
  channel: string;
  accountId?: string;
  direction: "inbound" | "outbound";
  target: MessageTarget;
  sender?: MessageActor;
  body?: MessageBody;
  attachments?: MessageAttachment[];
  relation?: MessageRelation;
  origin?: MessageOrigin;
  timestamp?: number;
  raw?: unknown;
};
```

### Target

The target describes where the message lives:

```typescript
type MessageTarget = {
  kind: "direct" | "group" | "channel" | "thread";
  id: string;
  label?: string;
  spaceId?: string;
  parentId?: string;
  threadId?: string;
  nativeChannelId?: string;
};
```

### Relation

Reply is a relation, not an API root:

```typescript
type MessageRelation =
  | {
      kind: "reply";
      inboundMessageId?: string;
      replyToId?: string;
      threadId?: string;
      quote?: MessageQuote;
    }
  | {
      kind: "followup";
      sessionKey?: string;
      previousMessageId?: string;
    }
  | {
      kind: "broadcast";
      reason?: string;
    }
  | {
      kind: "system";
      reason:
        | "approval"
        | "task"
        | "hook"
        | "cron"
        | "subagent"
        | "message_tool"
        | "cli"
        | "control_ui"
        | "automation"
        | "error";
    };
```

This lets the same send path handle normal replies, cron notifications, approval
prompts, task completions, message-tool sends, CLI or Control UI sends, subagent
results, and automation sends.

### Origin

Origin describes who produced a message and how OpenClaw should treat echoes of
that message. It is separate from relation: a message can be a reply to a user
and still be OpenClaw-originated operational output.

```typescript
type MessageOrigin =
  | {
      source: "openclaw";
      schemaVersion: 1;
      kind: "gateway_failure";
      code: "agent_failed_before_reply" | "missing_api_key" | "model_login_expired";
      echoPolicy: "drop_bot_room_echo";
    }
  | {
      source: "user" | "external_bot" | "platform" | "unknown";
    };
```

Core owns the meaning of OpenClaw-originated output. Channels own how that
origin is encoded into their transport.

The first required use is gateway failure output. Humans should still see
messages such as "Agent failed before reply" or "Missing API key", but tagged
OpenClaw operational output must not be accepted as bot-authored input in shared
rooms when `allowBots` is enabled.

### Receipt

Receipts are first-class:

```typescript
type MessageReceipt = {
  primaryPlatformMessageId?: string;
  platformMessageIds: string[];
  parts: MessageReceiptPart[];
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  url?: string;
  sentAt: number;
  raw?: unknown;
};

type MessageReceiptPart = {
  platformMessageId: string;
  kind: "text" | "media" | "voice" | "card" | "preview" | "unknown";
  index: number;
  threadId?: string;
  replyToId?: string;
  editToken?: string;
  deleteToken?: string;
  url?: string;
  raw?: unknown;
};
```

Receipts are the bridge from durable intent to future edit, delete, preview
finalization, duplicate suppression, and recovery.

A receipt can describe one platform message or a multi-part delivery. Chunked
text, media plus text, voice plus text, and card fallbacks must preserve all
platform ids while still exposing a primary id for threading and later edits.

## Receive context

Receiving should not be a bare helper call. The core needs a context that knows
dedupe, routing, session recording, and platform ack policy.

```typescript
type MessageReceiveContext = {
  id: string;
  channel: string;
  accountId?: string;
  input: ChannelMessage;
  ack: ReceiveAckController;
  route: MessageRouteController;
  session: MessageSessionController;
  log: MessageLifecycleLogger;

  dedupe(): Promise<ReceiveDedupeResult>;
  resolve(): Promise<ResolvedInboundMessage>;
  record(resolved: ResolvedInboundMessage): Promise<RecordResult>;
  dispatch(recorded: RecordResult): Promise<DispatchResult>;
  commit(result: DispatchResult): Promise<void>;
  fail(error: unknown): Promise<void>;
};
```

Receive flow:

```text
platform event
  -> begin receive context
  -> normalize
  -> classify
  -> dedupe and self-echo gate
  -> route and authorize
  -> record inbound session metadata
  -> dispatch agent run
  -> durable outbound sends happen through send context
  -> commit receive
  -> ack platform when policy allows
```

Ack is not one thing. The receive contract must keep these signals separate:

- **Transport ack:** tells the platform webhook or socket that OpenClaw accepted
  the event envelope. Some platforms require this before dispatch.
- **Polling offset ack:** advances a cursor so the same event is not fetched
  again. This must not advance past work that cannot be recovered.
- **Inbound record ack:** confirms OpenClaw persisted enough inbound metadata to
  dedupe and route a redelivery.
- **User-visible receipt:** optional read/status/typing behavior; never a
  durability boundary.

`ReceiveAckPolicy` controls transport or polling acknowledgement only. It must
not be reused for read receipts or status reactions.

Before bot authorization, receive must apply the shared OpenClaw echo policy
when the channel can decode message origin metadata:

```typescript
function shouldDropOpenClawEcho(params: {
  origin?: MessageOrigin;
  isBotAuthor: boolean;
  isRoomish: boolean;
}): boolean {
  return (
    params.isBotAuthor &&
    params.isRoomish &&
    params.origin?.source === "openclaw" &&
    params.origin.kind === "gateway_failure" &&
    params.origin.echoPolicy === "drop_bot_room_echo"
  );
}
```

This drop is tag-based, not text-based. A bot-authored room message with the
same visible gateway-failure text but without OpenClaw origin metadata still
goes through normal `allowBots` authorization.

Ack policy is explicit:

```typescript
type ReceiveAckPolicy =
  | { kind: "immediate"; reason: "webhook-timeout" | "platform-contract" }
  | { kind: "after-record" }
  | { kind: "after-durable-send" }
  | { kind: "manual" };
```

Telegram polling now uses the receive-context ack policy for its persisted
restart watermark. The tracker still observes grammY updates as they enter the
middleware chain, but OpenClaw persists only the safe completed update id after
successful dispatch, leaving failed or lower pending updates replayable after a
restart. Telegram's upstream `getUpdates` fetch offset is still controlled by
the polling library, so the remaining deeper cut is a fully durable polling
source if we need platform-level redelivery beyond OpenClaw's restart
watermark. Webhook platforms may need immediate HTTP ack, but they still need
inbound dedupe and durable outbound send intents because webhooks can redeliver.

## Send context

Sending is also context based:

```typescript
type MessageSendContext = {
  id: string;
  channel: string;
  accountId?: string;
  message: ChannelMessage;
  intent: DurableSendIntent;
  attempt: number;
  signal: AbortSignal;
  previousReceipt?: MessageReceipt;
  preview?: LiveMessageState;
  log: MessageLifecycleLogger;

  render(): Promise<RenderedMessageBatch>;
  previewUpdate(rendered: RenderedMessageBatch): Promise<LiveMessageState>;
  send(rendered: RenderedMessageBatch): Promise<MessageReceipt>;
  edit(receipt: MessageReceipt, rendered: RenderedMessageBatch): Promise<MessageReceipt>;
  delete(receipt: MessageReceipt): Promise<void>;
  commit(receipt: MessageReceipt): Promise<void>;
  fail(error: unknown): Promise<void>;
};
```

Preferred orchestration:

```typescript
await core.messages.withSendContext(message, async (ctx) => {
  const rendered = await ctx.render();

  if (ctx.preview?.canFinalizeInPlace) {
    return await ctx.edit(ctx.preview.receipt, rendered);
  }

  return await ctx.send(rendered);
});
```

The helper expands to:

```text
begin durable intent
  -> render
  -> optional preview/edit/stream work
  -> mark sending
  -> final platform send or final edit
  -> mark committing with raw receipt
  -> commit receipt
  -> ack durable intent
  -> fail durable intent on classified failure
```

The intent must exist before transport I/O. A restart after begin but before
commit is recoverable.

The dangerous boundary is after platform success and before receipt commit. If a
process dies there, OpenClaw cannot know whether the platform message exists
unless the adapter provides native idempotency or a receipt reconciliation path.
Those attempts must resume in `unknown_after_send`, not blindly replay. Channels
without reconciliation may choose at-least-once replay only if duplicate visible
messages are an acceptable, documented tradeoff for that channel and relation.
The current SDK reconciliation bridge requires the adapter to declare
`reconcileUnknownSend`, then asks `durableFinal.reconcileUnknownSend` to
classify an unknown entry as `sent`, `not_sent`, or `unresolved`; only `not_sent`
permits replay, and unresolved entries stay terminal or retry only the
reconciliation check.

Durability policy must be explicit:

```typescript
type MessageDurabilityPolicy = "required" | "best_effort" | "disabled";
```

`required` means core must fail closed when it cannot write the durable intent.
`best_effort` can fall through when persistence is unavailable. `disabled` keeps
the old direct send behavior. During migration, legacy wrappers and public
compatibility helpers default to `disabled`; they must not infer `required` from
the fact that a channel has a generic outbound adapter.

Send contexts also own channel-local post-send effects. A migration is not safe
if durable delivery bypasses local behavior that was previously attached to the
channel's direct send path. Examples include self-echo suppression caches,
thread participation markers, native edit anchors, model-signature rendering,
and platform-specific duplicate guards. Those effects must either move into the
send adapter, the render adapter, or a named send-context hook before that
channel can enable durable generic final delivery.

Send helpers must return receipts all the way back to their caller. Durable
wrappers cannot swallow message ids or replace a channel delivery result with
`undefined`; buffered dispatchers use those ids for thread anchors, later edits,
preview finalization, and duplicate suppression.

Fallback sends operate on batches, not single payloads. Silent-reply rewrites,
media fallback, card fallback, and chunk projection can all produce more than
one deliverable message, so a send context must either deliver the whole
projected batch or explicitly document why only one payload is valid.

```typescript
type RenderedMessageBatch = {
  units: RenderedMessageUnit[];
  atomicity: "all_or_retry_remaining" | "best_effort_parts";
  idempotencyKey: string;
};

type RenderedMessageUnit = {
  index: number;
  kind: "text" | "media" | "voice" | "card" | "preview" | "unknown";
  payload: unknown;
  required: boolean;
};
```

When such a fallback is durable, the whole projected batch must be represented by
one durable send intent or another atomic batch plan. Recording each payload
one-by-one is not enough: a crash between payloads can leave a partial visible
fallback with no durable record for the remaining payloads. Recovery must know
which units already have receipts and either replay only missing units or mark
the batch `unknown_after_send` until the adapter reconciles it.

## Live context

Preview, edit, progress, and stream behavior should be one opt-in lifecycle.

```typescript
type MessageLiveAdapter = {
  begin?(ctx: MessageSendContext): Promise<LiveMessageState>;
  update?(
    ctx: MessageSendContext,
    state: LiveMessageState,
    update: LiveMessageUpdate,
  ): Promise<LiveMessageState>;
  finalize?(
    ctx: MessageSendContext,
    state: LiveMessageState,
    final: RenderedMessageBatch,
  ): Promise<MessageReceipt>;
  cancel?(
    ctx: MessageSendContext,
    state: LiveMessageState,
    reason: LiveCancelReason,
  ): Promise<void>;
};
```

Live state is durable enough to recover or suppress duplicates:

```typescript
type LiveMessageState = {
  mode: "partial" | "block" | "progress" | "native";
  receipt?: MessageReceipt;
  visibleSince?: number;
  canFinalizeInPlace: boolean;
  lastRenderedHash?: string;
  staleAfterMs?: number;
};
```

This should cover current behavior:

- Telegram send plus edit preview, with fresh final after stale preview age.
- Discord send plus edit preview, cancel on media/error/explicit reply.
- Slack native stream or draft preview depending on thread shape.
- Mattermost draft post finalization.
- Matrix draft event finalization or redaction on mismatch.
- Teams native progress stream.
- QQ Bot stream or accumulated fallback.

## Adapter surface

The public SDK target should be one subpath:

```typescript
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-message";
```

Target shape:

```typescript
type ChannelMessageAdapter = {
  receive?: MessageReceiveAdapter;
  send: MessageSendAdapter;
  live?: MessageLiveAdapter;
  origin?: MessageOriginAdapter;
  render?: MessageRenderAdapter;
  capabilities: MessageCapabilities;
};
```

Send adapter:

```typescript
type MessageSendAdapter = {
  send(ctx: MessageSendContext, rendered: RenderedMessageBatch): Promise<MessageReceipt>;
  edit?(
    ctx: MessageSendContext,
    receipt: MessageReceipt,
    rendered: RenderedMessageBatch,
  ): Promise<MessageReceipt>;
  delete?(ctx: MessageSendContext, receipt: MessageReceipt): Promise<void>;
  classifyError?(ctx: MessageSendContext, error: unknown): DeliveryFailureKind;
  reconcileUnknownSend?(ctx: MessageSendContext): Promise<MessageReceipt | null>;
  afterSendSuccess?(ctx: MessageSendContext, receipt: MessageReceipt): Promise<void>;
  afterCommit?(ctx: MessageSendContext, receipt: MessageReceipt): Promise<void>;
};
```

Receive adapter:

```typescript
type MessageReceiveAdapter<TRaw = unknown> = {
  normalize(raw: TRaw, ctx: MessageNormalizeContext): Promise<ChannelMessage>;
  classify?(message: ChannelMessage): Promise<MessageEventClass>;
  preflight?(message: ChannelMessage, event: MessageEventClass): Promise<MessagePreflightResult>;
  ackPolicy?(message: ChannelMessage, event: MessageEventClass): ReceiveAckPolicy;
};
```

Before preflight authorization, core must run the shared OpenClaw echo predicate
whenever `origin.decode` returns OpenClaw-origin metadata. The receive adapter
supplies platform facts such as bot author and room shape; core owns the drop
decision and ordering so channels do not reimplement text filters.

Origin adapter:

```typescript
type MessageOriginAdapter<TRaw = unknown, TNative = unknown> = {
  encode?(origin: MessageOrigin): TNative | undefined;
  decode?(raw: TRaw): MessageOrigin | undefined;
};
```

Core sets `MessageOrigin`. Channels only translate it to and from native
transport metadata. Slack maps this to `chat.postMessage({ metadata })` and
inbound `message.metadata`; Matrix can map it to extra event content; channels
without native metadata can use a receipt/outbound registry when that is the
best available approximation.

Capabilities:

```typescript
type MessageCapabilities = {
  text: { maxLength?: number; chunking?: boolean };
  attachments?: {
    upload: boolean;
    remoteUrl: boolean;
    voice?: boolean;
  };
  threads?: {
    reply: boolean;
    topic?: boolean;
    nativeThread?: boolean;
  };
  live?: {
    edit: boolean;
    delete: boolean;
    nativeStream?: boolean;
    progress?: boolean;
  };
  delivery?: {
    idempotencyKey?: boolean;
    retryAfter?: boolean;
    receiptRequired?: boolean;
  };
};
```

## Public SDK reduction

The new public surface should absorb or deprecate these conceptual areas:

- `reply-runtime`
- `reply-dispatch-runtime`
- `reply-reference`
- `reply-chunking`
- `reply-payload`
- `inbound-reply-dispatch`
- `channel-reply-pipeline`
- most public uses of `outbound-runtime`
- ad hoc draft stream lifecycle helpers

Compatibility subpaths can remain as wrappers, but new third-party plugins
should not need them.

Bundled plugins may keep internal helper imports through reserved runtime
subpaths while migrating. Public docs should steer plugin authors to
`plugin-sdk/channel-message` once it exists.

## Relationship to channel turn

`runtime.channel.turn.*` should stay during migration.

It should become a compatibility adapter:

```text
channel.turn.run
  -> messages.receive context
  -> session dispatch
  -> messages.send context for visible output
```

`channel.turn.runPrepared` should also remain initially:

```text
channel-owned dispatcher
  -> messages.receive record/finalize bridge
  -> messages.live for preview/progress
  -> messages.send for final delivery
```

After all bundled plugins and known third-party compatibility paths are bridged,
`channel.turn` can be deprecated. It should not be removed until there is a
published SDK migration path and contract tests proving old plugins still work
or fail with a clear version error.

## Compatibility guardrails

During migration, generic durable delivery is opt-in for any channel whose
existing delivery callback has side effects beyond "send this payload".

Legacy entry points are non-durable by default:

- `channel.turn.run` and `dispatchAssembledChannelTurn` use the channel's
  delivery callback unless that channel explicitly supplies an audited durable
  policy/options object.
- `channel.turn.runPrepared` stays channel-owned until the prepared dispatcher
  explicitly calls the send context.
- Public compatibility helpers such as `recordInboundSessionAndDispatchReply`,
  `dispatchInboundReplyWithBase`, and direct-DM helpers never inject generic
  durable delivery before the caller-provided `deliver` or `reply` callback.

For migration bridge types, `durable: undefined` means "not durable". The
durable path is enabled only by an explicit policy/options value. `durable:
false` can remain as a compatibility spelling, but implementation should not
require every unmigrated channel to add it.

Current bridge code must keep the durability decision explicit:

- Durable final delivery returns a discriminated status. `handled_visible` and
  `handled_no_send` are terminal; `unsupported` and `not_applicable` may fall
  back to channel-owned delivery; `failed` propagates the send failure.
- Generic durable final delivery is gated by adapter capabilities such as
  silent delivery, reply target preservation, native quote preservation, and
  message-sending hooks. Missing parity should choose channel-owned delivery,
  not a generic send that changes user-visible behavior.
- Queue-backed durable sends expose a delivery intent reference. Existing
  `pendingFinalDelivery*` session fields can carry the intent id during the
  transition; the end state is a `MessageSendIntent` store instead of frozen
  reply text plus ad hoc context fields.

Do not enable the generic durable path for a channel until all of these are
true:

- The generic send adapter executes the same rendering and transport behavior as
  the old direct path.
- Local post-send side effects are preserved through the send context.
- The adapter returns receipts or delivery results with all platform message
  ids.
- Prepared dispatcher paths either call the new send context or stay documented
  as outside the durable guarantee.
- Fallback delivery handles every projected payload, not only the first one.
- Durable fallback delivery records the whole projected payload array as one
  replayable intent or batch plan.

Concrete migration hazards to preserve:

- iMessage monitor delivery records sent messages in an echo cache after a
  successful send. Durable final sends must still populate that cache, otherwise
  OpenClaw can re-ingest its own final replies as inbound user messages.
- Tlon appends an optional model signature and records participated threads
  after group replies. Generic durable delivery must not bypass those effects;
  either move them into Tlon render/send/finalize adapters or keep Tlon on the
  channel-owned path.
- Discord and other prepared dispatchers already own direct delivery and preview
  behavior. They are not covered by an assembled-turn durable guarantee until
  their prepared dispatchers explicitly route finals through the send context.
- Telegram silent fallback delivery must deliver the full projected payload
  array. A single-payload shortcut can drop additional fallback payloads after
  projection.
- LINE, BlueBubbles, Zalo, Nostr, and other existing assembled/helper paths may
  have reply-token handling, media proxying, sent-message caches, loading/status
  cleanup, or callback-only targets. They stay on channel-owned delivery until
  those semantics are represented by the send adapter and verified by tests.
- Direct-DM helpers can have a reply callback that is the only correct transport
  target. Generic outbound must not guess from `OriginatingTo` or `To` and skip
  that callback.
- OpenClaw gateway failure output must stay visible to humans, but tagged
  bot-authored room echoes must be dropped before `allowBots` authorization.
  Channels must not implement this with visible-text prefix filters except as a
  short emergency stopgap; the durable contract is structured origin metadata.

## Internal storage

The durable queue should store message send intents, not reply payloads.

```typescript
type DurableSendIntent = {
  id: string;
  idempotencyKey: string;
  channel: string;
  accountId?: string;
  message: ChannelMessage;
  batch?: RenderedMessageBatch;
  liveState?: LiveMessageState;
  status:
    | "pending"
    | "sending"
    | "committing"
    | "unknown_after_send"
    | "sent"
    | "failed"
    | "cancelled";
  attempt: number;
  nextAttemptAt?: number;
  receipt?: MessageReceipt;
  partialReceipt?: MessageReceipt;
  failure?: DeliveryFailure;
  createdAt: number;
  updatedAt: number;
};
```

Recovery loop:

```text
load pending or sending intents
  -> acquire idempotency lock
  -> skip if receipt already committed
  -> reconstruct send context
  -> render if needed
  -> reconcile unknown_after_send if needed
  -> call adapter send/edit/finalize
  -> commit receipt, mark unknown_after_send, or schedule retry
```

The queue should keep enough identity to replay through the same account,
thread, target, formatting policy, and media rules after restart.

## Failure classes

Channel adapters classify transport failures into closed categories:

```typescript
type DeliveryFailureKind =
  | "transient"
  | "rate_limit"
  | "auth"
  | "permission"
  | "not_found"
  | "invalid_payload"
  | "conflict"
  | "cancelled"
  | "unknown";
```

Core policy:

- Retry `transient` and `rate_limit`.
- Do not retry `invalid_payload` unless a render fallback exists.
- Do not retry `auth` or `permission` until configuration changes.
- For `not_found`, let live finalization fall back from edit to fresh send when
  the channel declares that safe.
- For `conflict`, use receipt/idempotency rules to decide whether the message
  already exists.
- Any error after the adapter may have completed platform I/O but before receipt
  commit becomes `unknown_after_send` unless the adapter can prove the platform
  operation did not happen.

## Channel mapping

| Channel                  | Target migration                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram                 | Receive ack policy plus durable final sends. Live adapter owns send plus edit preview, stale preview final send, topics, quote-reply preview skip, media fallback, and retry-after handling.                                                                                                                                                                   |
| Discord                  | Send adapter wraps existing durable payload delivery. Live adapter owns draft edit, progress draft, media/error preview cancel, reply target preservation, and message id receipts. Audit bot-authored gateway-failure echoes in shared rooms; use an outbound registry or other native equivalent if Discord cannot carry origin metadata on normal messages. |
| Slack                    | Send adapter handles normal chat posts. Live adapter chooses native stream when thread shape supports it, otherwise draft preview. Receipts preserve thread timestamps. Origin adapter maps OpenClaw gateway failures to Slack `chat.postMessage.metadata` and drops tagged bot-room echoes before `allowBots` authorization.                                  |
| WhatsApp                 | Send adapter owns text/media send with durable final intents. Receive adapter handles group mention and sender identity. Live can stay absent until WhatsApp has an editable transport.                                                                                                                                                                        |
| Matrix                   | Live adapter owns draft event edits, finalization, redaction, encrypted media constraints, and reply-target mismatch fallback. Receive adapter owns encrypted event hydration and dedupe. Origin adapter should encode OpenClaw gateway-failure origin into Matrix event content and drop configured-bot room echoes before `allowBots` handling.              |
| Mattermost               | Live adapter owns one draft post, progress/tool folding, finalization in place, and fresh-send fallback.                                                                                                                                                                                                                                                       |
| Microsoft Teams          | Live adapter owns native progress and block stream behavior. Send adapter owns activities and attachment/card receipts.                                                                                                                                                                                                                                        |
| Feishu                   | Render adapter owns text/card/raw rendering. Live adapter owns streaming cards and duplicate final suppression. Send adapter owns comments, topic sessions, media, and voice suppression.                                                                                                                                                                      |
| QQ Bot                   | Live adapter owns C2C streaming, accumulator timeout, and fallback final send. Render adapter owns media tags and text-as-voice.                                                                                                                                                                                                                               |
| Signal                   | Simple receive plus send adapter. No live adapter unless signal-cli adds reliable edit support.                                                                                                                                                                                                                                                                |
| iMessage and BlueBubbles | Simple receive plus send adapter. iMessage send must preserve monitor echo-cache population before durable finals can bypass monitor delivery. BlueBubbles-specific typing, reactions, and attachments remain adapter capabilities.                                                                                                                            |
| Google Chat              | Simple receive plus send adapter with thread relation mapped to spaces and thread ids. Audit `allowBots=true` room behavior for tagged OpenClaw gateway-failure echoes.                                                                                                                                                                                        |
| LINE                     | Simple receive plus send adapter with reply-token constraints modeled as target/relation capability.                                                                                                                                                                                                                                                           |
| Nextcloud Talk           | SDK receive bridge plus send adapter.                                                                                                                                                                                                                                                                                                                          |
| IRC                      | Simple receive plus send adapter, no durable edit receipts.                                                                                                                                                                                                                                                                                                    |
| Nostr                    | Receive plus send adapter for encrypted DMs; receipts are event ids.                                                                                                                                                                                                                                                                                           |
| QA Channel               | Contract-test adapter for receive, send, live, retry, and recovery behavior.                                                                                                                                                                                                                                                                                   |
| Synology Chat            | Simple receive plus send adapter.                                                                                                                                                                                                                                                                                                                              |
| Tlon                     | Send adapter must preserve model-signature rendering and participated-thread tracking before generic durable final delivery is enabled.                                                                                                                                                                                                                        |
| Twitch                   | Simple receive plus send adapter with rate-limit classification.                                                                                                                                                                                                                                                                                               |
| Zalo                     | Simple receive plus send adapter.                                                                                                                                                                                                                                                                                                                              |
| Zalo Personal            | Simple receive plus send adapter.                                                                                                                                                                                                                                                                                                                              |

## Migration plan

### Phase 1: Internal Message Domain

- Add `src/channels/message/*` types for messages, targets, relations,
  origins, receipts, capabilities, durable intents, receive context, send
  context, live context, and failure classes.
- Add `origin?: MessageOrigin` to the migration bridge payload type used by
  current reply delivery, then move that field to `ChannelMessage` and rendered
  message types as the refactor replaces reply payloads.
- Keep this internal until adapters and tests prove the shape.
- Add pure unit tests for state transitions and serialization.

### Phase 2: Durable Send Core

- Move the existing outbound queue from reply-payload durability to durable
  message send intents.
- Let a durable send intent carry a projected payload array or batch plan, not
  only one reply payload.
- Preserve the current queue recovery behavior through compatibility conversion.
- Make `deliverOutboundPayloads` call `messages.send`.
- Make final-send durability the default and fail closed when the durable intent
  cannot be written in the new message lifecycle, after the adapter declares
  replay safety. Existing channel-turn and SDK compatibility paths remain
  direct-send by default during this phase.
- Record receipts consistently.
- Return receipts and delivery results to the original dispatcher caller instead
  of treating durable send as a terminal side effect.
- Persist message origin through durable send intents so recovery, replay, and
  chunked sends preserve OpenClaw operational provenance.

### Phase 3: Channel Turn Bridge

- Reimplement `channel.turn.run` and `dispatchAssembledChannelTurn` on top of
  `messages.receive` and `messages.send`.
- Keep current fact types stable.
- Keep legacy behavior by default. An assembled-turn channel becomes durable
  only when its adapter explicitly opts in with a replay-safe durability policy.
- Keep `durable: false` as a compatibility escape hatch for paths that finalize
  native edits and cannot replay safely yet, but do not rely on `false` markers
  to protect unmigrated channels.
- Default assembled-turn durability only in the new message lifecycle, after
  the channel mapping proves the generic send path preserves the old channel
  delivery semantics.

### Phase 4: Prepared Dispatcher Bridge

- Replace `deliverDurableInboundReplyPayload` with a send-context bridge.
- Keep the old helper as a wrapper.
- Port Telegram, WhatsApp, Slack, Signal, iMessage, and Discord first because
  they already have durable-final work or simpler send paths.
- Treat every prepared dispatcher as uncovered until it explicitly opts in to
  the send context. Documentation and changelog entries must say "assembled
  channel turns" or name the migrated channel paths rather than claiming all
  automatic final replies.
- Keep `recordInboundSessionAndDispatchReply`, direct-DM helpers, and similar
  public compatibility helpers behavior-preserving. They may expose an explicit
  send-context opt-in later, but must not automatically attempt generic durable
  delivery before the caller-owned delivery callback.

### Phase 5: Unified Live Lifecycle

- Build `messages.live` with two proof adapters:
  - Telegram for send plus edit plus stale final send.
  - Matrix for draft finalization plus redaction fallback.
- Then migrate Discord, Slack, Mattermost, Teams, QQ Bot, and Feishu.
- Delete duplicated preview finalization code only after each channel has
  parity tests.

### Phase 6: Public SDK

- Add `openclaw/plugin-sdk/channel-message`.
- Document it as the preferred channel plugin API.
- Update package exports, entrypoint inventory, generated API baselines, and
  plugin SDK docs.
- Include `MessageOrigin`, origin encode/decode hooks, and the shared
  `shouldDropOpenClawEcho` predicate in the channel-message SDK surface.
- Keep compatibility wrappers for old subpaths.
- Mark reply-named SDK helpers as deprecated in docs after bundled plugins are
  migrated.

### Phase 7: All Senders

Move all non-reply outbound producers onto `messages.send`:

- cron and heartbeat notifications
- task completions
- hook results
- approval prompts and approval results
- message tool sends
- subagent completion announcements
- explicit CLI or Control UI sends
- automation/broadcast paths

This is where the model stops being "agent replies" and becomes "OpenClaw sends
messages".

### Phase 8: Deprecate Turn

- Keep `channel.turn` as a wrapper for at least one compatibility window.
- Publish migration notes.
- Run plugin SDK compatibility tests against old imports.
- Remove or hide old internal helpers only after no bundled plugin needs them
  and third-party contracts have a stable replacement.

## Test plan

Unit tests:

- Durable send intent serialization and recovery.
- Idempotency key reuse and duplicate suppression.
- Receipt commit and replay skip.
- `unknown_after_send` recovery that reconciles before replay when an adapter
  supports reconciliation.
- Failure classification policy.
- Receive ack policy sequencing.
- Relation mapping for reply, followup, system, and broadcast sends.
- Gateway-failure origin factory and `shouldDropOpenClawEcho` predicate.
- Origin preservation through payload normalization, chunking, durable queue
  serialization, and recovery.

Integration tests:

- `channel.turn.run` simple adapter still records and sends.
- Legacy assembled-turn delivery does not become durable unless the channel
  explicitly opts in.
- `channel.turn.runPrepared` bridge still records and finalizes.
- Public compatibility helpers call caller-owned delivery callbacks by default
  and do not generic-send before those callbacks.
- Durable fallback delivery replays the whole projected payload array after
  restart and cannot leave the later payloads unrecorded after an early crash.
- Durable assembled-turn delivery returns platform message ids to the buffered
  dispatcher.
- Custom delivery hooks still return platform message ids when durable delivery
  is disabled or unavailable.
- Final reply survives restart between assistant completion and platform send.
- Preview draft finalizes in place when allowed.
- Preview draft is cancelled or redacted when media/error/reply-target mismatch
  requires normal delivery.
- Block streaming and preview streaming do not both deliver the same text.
- Media streamed early is not duplicated in final delivery.

Channel tests:

- Telegram topic reply with polling ack delayed until the receive context's safe
  completed watermark.
- Telegram polling recovery for accepted-but-not-delivered updates covered by
  the persisted safe-completed offset model.
- Telegram stale preview sends fresh final and cleans up preview.
- Telegram silent fallback sends every projected fallback payload.
- Telegram silent fallback durability records the full projected fallback array
  atomically, not one single-payload durable intent per loop iteration.
- Discord preview cancel on media/error/explicit reply.
- Discord prepared dispatcher finals route through the send context before docs
  or changelog claim Discord final-reply durability.
- iMessage durable final sends populate the monitor sent-message echo cache.
- LINE, BlueBubbles, Zalo, and Nostr legacy delivery paths are not bypassed by
  generic durable send until their adapter parity tests exist.
- Direct-DM/Nostr callback delivery remains authoritative unless explicitly
  migrated to a complete message target and replay-safe send adapter.
- Slack tagged OpenClaw gateway failure messages stay visible outbound, tagged
  bot-room echoes drop before `allowBots`, and untagged bot messages with the
  same visible text still follow normal bot authorization.
- Slack native stream fallback to draft preview in top-level DMs.
- Matrix preview finalization and redaction fallback.
- Matrix tagged OpenClaw gateway-failure room echoes from configured bot
  accounts drop before `allowBots` handling.
- Discord and Google Chat shared-room gateway-failure cascade audits cover
  `allowBots` modes before claiming generic protection there.
- Mattermost draft finalization and fresh-send fallback.
- Teams native progress finalization.
- Feishu duplicate final suppression.
- QQ Bot accumulator timeout fallback.
- Tlon durable final sends preserve model-signature rendering and participated
  thread tracking.
- WhatsApp, Signal, iMessage, Google Chat, LINE, IRC, Nostr, Nextcloud Talk,
  Synology Chat, Tlon, Twitch, Zalo, and Zalo Personal simple durable final
  sends.

Validation:

- Targeted Vitest files during development.
- `pnpm check:changed` in Testbox for the full changed surface.
- Broader `pnpm check` in Testbox before landing the complete refactor or after
  public SDK/export changes.
- Live or qa-channel smoke for at least one edit-capable channel and one
  simple send-only channel before removing compatibility wrappers.

## Open questions

- Whether Telegram should eventually replace the grammY runner source with a
  fully durable polling source that can control platform-level redelivery, not
  only OpenClaw's persisted restart watermark.
- Whether durable live preview state should be stored in the same queue record
  as the final send intent or in a sibling live-state store.
- How long compatibility wrappers stay documented after
  `plugin-sdk/channel-message` ships.
- Whether third-party plugins should implement receive adapters directly or only
  provide normalize/send/live hooks through `defineChannelMessageAdapter`.
- Which receipt fields are safe to expose in public SDK versus internal runtime
  state.
- Whether side effects such as self-echo caches and participated-thread markers
  should be modeled as send-context hooks, adapter-owned finalize steps, or
  receipt subscribers.
- Which channels have native origin metadata, which need persisted outbound
  registries, and which cannot offer reliable cross-bot echo suppression.

## Acceptance criteria

- Every bundled message channel sends final visible output through
  `messages.send`.
- Every inbound message channel enters through `messages.receive` or a
  documented compatibility wrapper.
- Every preview/edit/stream channel uses `messages.live` for draft state and
  finalization.
- `channel.turn` is only a wrapper.
- Reply-named SDK helpers are compatibility exports, not the recommended path.
- Durable recovery can replay pending final sends after restart without losing
  the final response or duplicating already committed sends; sends whose
  platform outcome is unknown are reconciled before replay or documented as
  at-least-once for that adapter.
- Durable final sends fail closed when the durable intent cannot be written,
  unless a caller explicitly selected a documented non-durable mode.
- Legacy channel-turn and SDK compatibility helpers default to direct
  channel-owned delivery; generic durable send is explicit opt-in only.
- Receipts preserve all platform message ids for multi-part deliveries and a
  primary id for threading/edit convenience.
- Durable wrappers preserve channel-local side effects before replacing direct
  delivery callbacks.
- Prepared dispatchers are not counted as durable until their final delivery
  path explicitly uses the send context.
- Fallback delivery handles every projected payload.
- Durable fallback delivery records every projected payload in one replayable
  intent or batch plan.
- OpenClaw-originated gateway failure output is visible to humans but tagged
  bot-authored room echoes are dropped before bot authorization on channels that
  declare support for the origin contract.
- The docs explain send, receive, live, state, receipts, relations, failure
  policy, migration, and test coverage.

## Related

- [Messages](/concepts/messages)
- [Streaming and chunking](/concepts/streaming)
- [Progress drafts](/concepts/progress-drafts)
- [Retry policy](/concepts/retry)
- [Channel turn kernel](/plugins/sdk-channel-turn)
