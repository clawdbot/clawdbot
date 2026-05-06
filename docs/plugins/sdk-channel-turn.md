---
summary: "runtime.channel.turn -- the shared inbound turn kernel that bundled and third-party channel plugins use to record, dispatch, and finalize agent turns"
title: "Channel turn kernel"
sidebarTitle: "Channel turn"
read_when:
  - You are building a channel plugin and want the shared inbound turn lifecycle
  - You are migrating a channel monitor off hand-rolled record/dispatch glue
  - You need to understand admission, ingest, classify, preflight, resolve, record, dispatch, and finalize stages
---

The channel turn kernel is the shared inbound state machine that turns a normalized platform event into an agent turn. Channel plugins provide the platform facts and the delivery callback. Core owns the orchestration: ingest, classify, preflight, resolve, authorize, assemble, record, dispatch, and finalize.

Use this when your plugin is on the inbound message hot path. For non-message events (slash commands, modals, button interactions, lifecycle events, reactions, voice state), keep them plugin-local. The kernel only owns events that may become an agent text turn.

<Info>
  The kernel is reached through the injected plugin runtime as `runtime.channel.turn.*`. The plugin runtime type is exported from `openclaw/plugin-sdk/core`, so third-party native plugins can use these entry points the same way bundled channel plugins do.
</Info>

## Why a shared kernel

Channel plugins repeat the same inbound flow: normalize, route, gate, build a context, record session metadata, dispatch the agent turn, finalize delivery state. Without a shared kernel, a change to mention gating, tool-only visible replies, session metadata, pending history, or dispatch finalization has to be applied per channel.

The kernel keeps four concepts deliberately separate:

- `ConversationFacts`: where the message came from
- `RouteFacts`: which agent and session should process it
- `ReplyPlanFacts`: where visible replies should go
- `MessageFacts`: what body and supplemental context the agent should see

Slack DMs, Telegram topics, Matrix threads, and Feishu topic sessions all distinguish these in practice. Treating them as one identifier causes drift over time.

## Stage lifecycle

The kernel runs the same fixed pipeline regardless of channel:

1. `ingest` -- adapter converts a raw platform event into `NormalizedTurnInput`
2. `classify` -- adapter declares whether this event can start an agent turn
3. `preflight` -- adapter does dedupe, self-echo, hydration, debounce, decryption, partial fact prefill
4. `resolve` -- adapter returns a fully assembled turn (route, reply plan, message, delivery)
5. `authorize` -- DM, group, mention, and command policy applied to the assembled facts
6. `assemble` -- `FinalizedMsgContext` built from the facts via `buildContext`
7. `record` -- inbound session metadata and last route persisted
8. `dispatch` -- agent turn executed through the buffered block dispatcher
9. `finalize` -- adapter `onFinalize` runs even on dispatch error

Each stage emits a structured log event when a `log` callback is supplied. See [Observability](#observability).

## Admission kinds

The kernel does not throw when a turn is gated. It returns a `ChannelTurnAdmission`:

| Kind          | When                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatch`    | Turn is admitted. Agent turn runs and the visible reply path is exercised.                                                                   |
| `observeOnly` | Turn runs end-to-end but the delivery adapter sends nothing visible. Used for broadcast observer agents and other passive multi-agent flows. |
| `handled`     | A platform event was consumed locally (lifecycle, reaction, button, modal). Kernel skips dispatch.                                           |
| `drop`        | Skip path. Optionally `recordHistory: true` keeps the message in pending group history so a future mention has context.                      |

Admission can come from `classify` (event class said it cannot start a turn), from `preflight` (dedupe, self-echo, missing mention with history record), or from `resolveTurn` itself.

## Entry points

The runtime exposes three preferred entry points so adapters can opt in at the level that matches the channel.

```typescript
runtime.channel.turn.run(...)             // adapter-driven full pipeline
runtime.channel.turn.runPrepared(...)     // channel owns dispatch; kernel runs record + finalize
runtime.channel.turn.buildContext(...)    // pure facts to FinalizedMsgContext mapping
```

Two older runtime helpers remain available for Plugin SDK compatibility:

```typescript
runtime.channel.turn.runResolved(...)      // deprecated compatibility alias; prefer run
runtime.channel.turn.dispatchAssembled(...) // deprecated compatibility alias; prefer run or runPrepared
```

### run

Use when your channel can express its inbound flow as a `ChannelTurnAdapter<TRaw>`. The adapter has callbacks for `ingest`, optional `classify`, optional `preflight`, mandatory `resolveTurn`, and optional `onFinalize`.

```typescript
await runtime.channel.turn.run({
  channel: "tlon",
  accountId,
  raw: platformEvent,
  adapter: {
    ingest(raw) {
      return {
        id: raw.messageId,
        timestamp: raw.timestamp,
        rawText: raw.body,
        textForAgent: raw.body,
      };
    },
    classify(input) {
      return { kind: "message", canStartAgentTurn: input.rawText.length > 0 };
    },
    async preflight(input, eventClass) {
      if (await isDuplicate(input.id)) {
        return { admission: { kind: "drop", reason: "dedupe" } };
      }
      return {};
    },
    resolveTurn(input) {
      return buildAssembledTurn(input);
    },
    onFinalize(result) {
      clearPendingGroupHistory(result);
    },
  },
});
```

`run` is the right shape when the channel has small adapter logic and benefits from owning the lifecycle through hooks.

### runPrepared

Use when the channel has a complex local dispatcher with previews, retries, edits, or thread bootstrap that must stay channel-owned. The kernel still records the inbound session before dispatch and surfaces a uniform `DispatchedChannelTurnResult`.

```typescript
const { dispatchResult } = await runtime.channel.turn.runPrepared({
  channel: "matrix",
  accountId,
  routeSessionKey,
  storePath,
  ctxPayload,
  recordInboundSession,
  record: {
    onRecordError,
    updateLastRoute,
  },
  onPreDispatchFailure: async (err) => {
    await stopStatusReactions();
  },
  runDispatch: async () => {
    return await runMatrixOwnedDispatcher();
  },
});
```

Rich channels (Matrix, Mattermost, Microsoft Teams, Feishu, QQ Bot) use `runPrepared` because their dispatcher orchestrates platform-specific behavior the kernel must not learn about.

### buildContext

A pure function that maps fact bundles into `FinalizedMsgContext`. Use it when your channel hand-rolls part of the pipeline but wants consistent context shape.

```typescript
const ctxPayload = runtime.channel.turn.buildContext({
  channel: "googlechat",
  accountId,
  messageId,
  timestamp,
  from,
  sender,
  conversation,
  route,
  reply,
  message,
  access,
  media,
  supplemental,
});
```

`buildContext` is also useful inside `resolveTurn` callbacks when assembling a turn for `run`.

<Note>
  Deprecated SDK helpers such as `dispatchInboundReplyWithBase` still bridge through an assembled-turn helper. New plugin code should use `run` or `runPrepared`.
</Note>

## Fact types

The facts the kernel consumes from your adapter are platform-agnostic. Translate platform objects into these shapes before handing them to the kernel.

### NormalizedTurnInput

| Field             | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `id`              | Stable message id used for dedupe and logs                                   |
| `timestamp`       | Optional epoch ms                                                            |
| `rawText`         | Body as received from the platform                                           |
| `textForAgent`    | Optional cleaned body for the agent (mention strip, typing trim)             |
| `textForCommands` | Optional body used for `/command` parsing                                    |
| `raw`             | Optional pass-through reference for adapter callbacks that need the original |

### ChannelEventClass

| Field                  | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `kind`                 | `message`, `command`, `interaction`, `reaction`, `lifecycle`, `unknown` |
| `canStartAgentTurn`    | If false the kernel returns `{ kind: "handled" }`                       |
| `requiresImmediateAck` | Hint for adapters that need to ACK before dispatch                      |

### SenderFacts

| Field          | Purpose                                                        |
| -------------- | -------------------------------------------------------------- |
| `id`           | Stable platform sender id                                      |
| `name`         | Display name                                                   |
| `username`     | Handle if distinct from `name`                                 |
| `tag`          | Discord-style discriminator or platform tag                    |
| `roles`        | Role ids, used for member-role allowlist matching              |
| `isBot`        | True when the sender is a known bot (kernel uses for dropping) |
| `isSelf`       | True when the sender is the configured agent itself            |
| `displayLabel` | Pre-rendered label for envelope text                           |

### ConversationFacts

| Field             | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `kind`            | `direct`, `group`, or `channel`                                      |
| `id`              | Conversation id used for routing                                     |
| `label`           | Human label for the envelope                                         |
| `spaceId`         | Optional outer space identifier (Slack workspace, Matrix homeserver) |
| `parentId`        | Outer conversation id when this is a thread                          |
| `threadId`        | Thread id when this message is inside a thread                       |
| `nativeChannelId` | Platform-native channel id when different from the routing id        |
| `routePeer`       | Peer used for `resolveAgentRoute` lookup                             |

### RouteFacts

| Field                   | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `agentId`               | Agent that should handle this turn                         |
| `accountId`             | Optional override (multi-account channels)                 |
| `routeSessionKey`       | Session key used for routing                               |
| `dispatchSessionKey`    | Session key used at dispatch when different from route key |
| `persistedSessionKey`   | Session key written to persisted session metadata          |
| `parentSessionKey`      | Parent for branched/threaded sessions                      |
| `modelParentSessionKey` | Model-side parent for branched sessions                    |
| `mainSessionKey`        | Main DM owner pin for direct conversations                 |
| `createIfMissing`       | Allow record step to create a missing session row          |

### ReplyPlanFacts

| Field                     | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `to`                      | Logical reply target written into context `To`          |
| `originatingTo`           | Originating context target (`OriginatingTo`)            |
| `nativeChannelId`         | Platform-native channel id for delivery                 |
| `replyTarget`             | Final visible-reply destination if it differs from `to` |
| `deliveryTarget`          | Lower-level delivery override                           |
| `replyToId`               | Quoted/anchored message id                              |
| `replyToIdFull`           | Full-form quoted id when the platform has both          |
| `messageThreadId`         | Thread id at delivery time                              |
| `threadParentId`          | Parent message id of the thread                         |
| `sourceReplyDeliveryMode` | `thread`, `reply`, `channel`, `direct`, or `none`       |

### AccessFacts

`AccessFacts` carries the booleans the authorize stage needs. Identity matching stays in the channel: the kernel only consumes the result.

| Field      | Purpose                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `dm`       | DM allow/pairing/deny decision and `allowFrom` list                       |
| `group`    | Group policy, route allow, sender allow, allowlist, mention requirement   |
| `commands` | Command authorization across configured authorizers                       |
| `mentions` | Whether mention detection is possible and whether the agent was mentioned |

### MessageFacts

| Field            | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `body`           | Final envelope body (formatted)                                |
| `rawBody`        | Raw inbound body                                               |
| `bodyForAgent`   | Body the agent sees                                            |
| `commandBody`    | Body used for command parsing                                  |
| `envelopeFrom`   | Pre-rendered sender label for the envelope                     |
| `senderLabel`    | Optional override for the rendered sender                      |
| `preview`        | Short redacted preview for logs                                |
| `inboundHistory` | Recent inbound history entries when the channel keeps a buffer |

### SupplementalContextFacts

Supplemental context covers quote, forwarded, and thread-bootstrap context. The kernel applies the configured `contextVisibility` policy. The channel adapter only provides facts and `senderAllowed` flags so cross-channel policy stays consistent.

### InboundMediaFacts

Media is fact-shaped. Platform download, auth, SSRF policy, CDN rules, and decryption stay channel-local. The kernel maps facts into `MediaPath`, `MediaUrl`, `MediaType`, `MediaPaths`, `MediaUrls`, `MediaTypes`, and `MediaTranscribedIndexes`.

## Adapter contract

For full `run`, the adapter shape is:

```typescript
type ChannelTurnAdapter<TRaw> = {
  ingest(raw: TRaw): Promise<NormalizedTurnInput | null> | NormalizedTurnInput | null;
  classify?(input: NormalizedTurnInput): Promise<ChannelEventClass> | ChannelEventClass;
  preflight?(
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
  ): Promise<PreflightFacts | ChannelTurnAdmission | null | undefined>;
  resolveTurn(
    input: NormalizedTurnInput,
    eventClass: ChannelEventClass,
    preflight: PreflightFacts,
  ): Promise<ChannelTurnResolved> | ChannelTurnResolved;
  onFinalize?(result: ChannelTurnResult): Promise<void> | void;
};
```

`resolveTurn` returns a `ChannelTurnResolved`, which is an `AssembledChannelTurn` with an optional admission kind. Returning `{ admission: { kind: "observeOnly" } }` runs the turn without producing visible output. The adapter still owns the delivery callback; it just becomes a no-op for that turn.

`onFinalize` runs on every result, including dispatch errors. Use it to clear pending group history, remove ack reactions, stop status indicators, and flush local state.

## Delivery adapter

The kernel does not call the platform directly. The channel hands the kernel a `ChannelTurnDeliveryAdapter`:

```typescript
type ChannelTurnDeliveryAdapter = {
  deliver(payload: ReplyPayload, info: ChannelDeliveryInfo): Promise<ChannelDeliveryResult | void>;
  onError?(err: unknown, info: { kind: string }): void;
  durable?: false | DurableInboundReplyDeliveryOptions;
};

type ChannelDeliveryResult = {
  messageIds?: string[];
  receipt?: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
};
```

`deliver` is called once per buffered reply chunk. During the message-lifecycle migration, assembled channel-turn delivery is channel-owned by default: an omitted `durable` field means the kernel must call `deliver` directly and must not route through generic outbound delivery. Set `durable` only after the channel has been audited to prove the generic send path preserves the old delivery behavior, including reply/thread targets, media handling, sent-message/self-echo caches, status cleanup, and returned message ids. `durable: false` remains a compatibility spelling for "use the channel-owned callback", but unmigrated channels should not need to add it. Return platform message ids when the channel has them so the dispatcher can preserve thread anchors and edit later chunks; newer delivery paths should also return `receipt` so recovery, preview finalization, and duplicate suppression can move off `messageIds`. For observe-only turns, return `{ visibleReplySent: false }` or use `createNoopChannelTurnDeliveryAdapter()`.

Channels using `runPrepared` with a fully channel-owned dispatcher do not have a `ChannelTurnDeliveryAdapter`. Those dispatchers are not durable by default. They should keep their direct delivery path until they explicitly opt in to the new send context with a complete target, replay-safe adapter, receipt contract, and channel side-effect hooks.

Public compatibility helpers such as `recordInboundSessionAndDispatchReply`, `dispatchInboundReplyWithBase`, and direct-DM helpers must stay behavior-preserving during migration. They should not call generic durable delivery before caller-owned `deliver` or `reply` callbacks.

## Record options

The record stage wraps `recordInboundSession`. Most channels can use the defaults. Override via `record`:

```typescript
record: {
  groupResolution,
  createIfMissing: true,
  updateLastRoute,
  onRecordError: (err) => log.warn("record failed", err),
  trackSessionMetaTask: (task) => pendingTasks.push(task),
}
```

The dispatcher waits for the record stage. If record throws, the kernel runs `onPreDispatchFailure` (when provided to `runPrepared`) and rethrows.

## Observability

Each stage emits a structured event when a `log` callback is supplied:

```typescript
await runtime.channel.turn.run({
  channel: "twitch",
  accountId,
  raw,
  adapter,
  log: (event) => {
    runtime.log?.debug?.(`turn.${event.stage}:${event.event}`, {
      channel: event.channel,
      accountId: event.accountId,
      messageId: event.messageId,
      sessionKey: event.sessionKey,
      admission: event.admission,
      reason: event.reason,
    });
  },
});
```

Logged stages: `ingest`, `classify`, `preflight`, `resolve`, `authorize`, `assemble`, `record`, `dispatch`, `finalize`. Avoid logging raw bodies; use `MessageFacts.preview` for short redacted previews.

## What stays channel-local

The kernel owns orchestration. The channel still owns:

- Platform transports (gateway, REST, websocket, polling, webhooks)
- Identity resolution and display-name matching
- Native commands, slash commands, autocomplete, modals, buttons, voice state
- Card, modal, and adaptive-card rendering
- Media auth, CDN rules, encrypted media, transcription
- Edit, reaction, redaction, and presence APIs
- Backfill and platform-side history fetch
- Pairing flows that require platform-specific verification

If two channels start needing the same helper for one of these, extract a shared SDK helper instead of pushing it into the kernel.

## Stability

`runtime.channel.turn.*` is part of the public plugin runtime surface. The fact types (`SenderFacts`, `ConversationFacts`, `RouteFacts`, `ReplyPlanFacts`, `AccessFacts`, `MessageFacts`, `SupplementalContextFacts`, `InboundMediaFacts`) and admission shapes (`ChannelTurnAdmission`, `ChannelEventClass`) are reachable through `PluginRuntime` from `openclaw/plugin-sdk/core`.

Backward compatibility rules apply: new fact fields are additive, admission kinds are not renamed, and the entry point names stay stable. New channel needs that require a non-additive change must go through the plugin SDK migration process.

## Related

- [Message lifecycle refactor](/concepts/message-lifecycle-refactor) for the planned send/receive/live lifecycle that will wrap this kernel
- [Building channel plugins](/plugins/sdk-channel-plugins) for the broader channel plugin contract
- [Plugin runtime helpers](/plugins/sdk-runtime) for other `runtime.*` surfaces
- [Plugin internals](/plugins/architecture-internals) for load pipeline and registry mechanics
