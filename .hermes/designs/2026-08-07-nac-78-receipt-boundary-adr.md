# ADR: NAC-78 Telegram Receipt Boundary

**Status:** Proposed — design only; no implementation or activation authorized

**Date:** 2026-08-07

**Issue:** NAC-78 — Make buildout tracking mandatory and closeout-gated

**Decision branch:** `design/nac-78-receipt-boundary`

**Failed candidates retained as evidence:**

- `archive/nac-78-rejected-review-20260807` (`d457e39a53ac9477e6c04fc55eace2293cb28c9e`)
- `archive/nac-78-partial-red-20260807` (`3a6108bdfaa1421807a290de455441559868ed52`)

Neither archive is deployable.

## Context

NAC-78 requires a Kevin-visible Telegram closeout to have verified transport evidence before lifecycle completion, active-followup `visibleCloseoutSent`, or Workboard `done`. It also forbids duplicating a confirmed closeout and requires safe recovery after interrupted handoff.

The rejected implementation attempted two authorities:

1. A `message_sent` plugin journal.
2. A wrapper script that persisted the CLI-returned `messageId` after `openclaw message send --json` returned.

Both are unsafe:

- `message_sent` is explicitly best-effort and fire-and-forget (`src/infra/outbound/message-sent-hook.ts:21-85`, `src/hooks/fire-and-forget.ts:79-88`). It cannot gate completion.
- A wrapper script has an unavoidable crash gap after Telegram accepts the message but before the wrapper persists receipt evidence.
- The wrapper/plugin journals introduced parallel stores and inconsistent receipt schemas.
- Workboard status is a projection, not transport evidence.
- Telegram advertises no `reconcileUnknownSend` capability (`extensions/telegram/src/outbound-adapter.ts:438-450`) and has no arbitrary outbound-message readback path (`extensions/telegram/AGENTS.md:99-104`). A blind replay after an ambiguous provider attempt can duplicate delivery.

## Source findings

### Existing durable owner path

OpenClaw already provides the correct transport substrate:

- `sendDurableMessageBatch` creates a normalized `MessageReceipt` and awaits its commit callback (`src/channels/message/send.ts:188-203,255-320,372-407`).
- Concrete provider identity is reported through an awaited callback before observers (`src/infra/outbound/deliver-results.ts:47-59`).
- The queue persists post-send state before forwarding delivery results (`src/infra/outbound/deliver-queue.ts:328-334`).
- `DurableDeliveryCompletion` is serialized into the queue (`src/infra/outbound/delivery-completion.ts:12-18`). Its owner is finalized from platform evidence before queue acknowledgement during live delivery (`src/infra/outbound/deliver-queue.ts:420-503`) and recovery (`src/infra/outbound/delivery-queue-recovery.ts:622-652`).
- Unknown post-dispatch outcomes are not blindly replayed (`src/infra/outbound/delivery-queue-recovery.ts:622-716`).
- Message actions can already force the core queue path and carry `deliveryIntentId` plus `deliveryCompletion` (`src/infra/outbound/message-action-runner.ts:193-204,1576-1608`; `src/infra/outbound/outbound-send-service.ts:350-405`).
- The forced queue-persistence path already disables the public exact-reconciliation capability preflight (`src/infra/outbound/outbound-send-service.ts:181-185`; `src/infra/outbound/message.ts:410-423`). This allows Telegram to use required queue persistence while still preserving unknown outcomes instead of pretending the channel can reconcile them.
- The current completion function receives only `results.at(-1)` and stores one platform ID (`src/infra/outbound/delivery-completion.ts:27-53`; `src/infra/outbound/deliver-queue.ts:420-426`; `src/infra/outbound/delivery-queue-recovery.ts:831-838`). A new completion protocol must receive the full ordered result set and a normalized aggregate `MessageReceipt` (`src/channels/message/receipt.ts:45-120`).

### Telegram path

- The normal Telegram plugin action uses required durability but does not supply lifecycle settlement callbacks (`extensions/telegram/src/action-runtime.ts:554-603`).
- The first provider identity exists when grammY returns `Message.message_id`; it is normalized into the outbound result/receipt before the core delivery callback.
- Telegram sends are non-idempotent at the provider boundary; local idempotency prevents duplicate queue creation but is not a Telegram de-duplication token.
- Telegram currently cannot authoritatively prove absence after an ambiguous send. Therefore an unknown outcome cannot be converted into retry eligibility automatically.

## Decision

### 1. Reuse OpenClaw’s queue; do not add another outbox

No new daemon, plugin journal, Postgres service, Kafka/CDC stack, or paid product will be added. OpenClaw’s existing SQLite-backed durable queue owns transport intent, attempt fencing, provider result persistence, unknown-send recovery, and queue acknowledgement.

### 2. Add a generic, restart-resolvable completion-owner protocol

Do not hard-code NAC-78 lifecycle or Workboard semantics into core. Extend the queue's completion ownership as a typed SDK protocol:

```ts
type DurableDeliveryCompletion =
  | ConversationDeliveryCompletion
  | {
      kind: "plugin";
      pluginId: string;
      ownerType: string;
      ownerVersion: number;
      payload: JsonObject;
    };
```

Core owns validation of the bounded serializable envelope, queue persistence, dispatch ordering, terminal batch accounting, aggregate receipt construction, and handler resolution. A plugin may register one handler per `(pluginId, ownerType, ownerVersion)` through a typed SDK facade. Every transition is awaited and returns `Promise<void>`; rejection leaves the queue unacknowledged/failed. The registered handler owns its schema and durable store and must implement idempotent state transitions for:

- queued
- sent with a terminal batch settlement containing the full ordered result set, payload outcomes, expected-versus-identified visible-part accounting, and normalized aggregate `MessageReceipt`
- suppressed
- rejected before platform I/O
- unknown after possible platform I/O

Core resolves the persisted `(pluginId, ownerType, ownerVersion)` envelope before recovery's owner-completed shortcut and before any recovery acknowledgement. The same registered handler must resolve after process restart. Missing plugin, unknown owner version, invalid payload, handler failure, or conflicting settlement leaves the queue unacknowledged/failed and the lifecycle blocked. No process-local callback is the only settlement authority, and plugins never import `src/**` directly.

The terminal batch settlement is a discriminated result:

- `sent`: every expected visible payload/physical part succeeded with identified platform evidence; only this disposition carries an aggregate `MessageReceipt` and may transition to `receipt_settled`.
- `suppressed`: no visible delivery was required and no lifecycle receipt is created.
- `rejected_pre_io`: permanent, proven pre-I/O rejection; terminal and not retryable.
- `unknown_after_send`: dispatch may have occurred, including any partial batch delivery; no lifecycle receipt is settled and no automatic resend occurs.

A nonterminal retryable proven-not-sent queue failure is not a completion-owner disposition. It remains attached to the same deterministic queue intent and follows the queue's bounded retry policy.

### 3. Add one lifecycle-plugin-owned SQLite authority

The lifecycle plugin owns a versioned SQLite database under its approved plugin state root. It does not share Workboard's SQLite database and does not imply that Workboard is the receipt authority. It owns immutable intent, aggregate receipt, manual-disposition, and projection state. Existing JSON lifecycle files, `active-followups.json`, Workboard, Linear, and session events become projections/reconciliation inputs, not receipt authorities.

#### Intent identity

An immutable intent contains:

```json
{
  "schemaVersion": 1,
  "intentId": "uuid",
  "jobId": "NAC-78",
  "workboardTaskId": "card-id",
  "followupId": "followup-id",
  "idempotencyKey": "NAC-78:closeout",
  "transport": "telegram",
  "accountId": "default",
  "receiptTarget": "canonical-target",
  "sourceSessionKey": "agent:...",
  "payloadSha256": "sha256",
  "intentAt": "RFC3339"
}
```

Uniqueness:

- `UNIQUE(intent_id)`
- `UNIQUE(job_id, workboard_task_id, idempotency_key)`

Byte-identical replay returns the existing intent. Any identity change conflicts and fails closed.

#### Settled receipt

A confirmed receipt contains:

```json
{
  "schemaVersion": 1,
  "authority": "openclaw.durable-delivery-completion",
  "intentId": "uuid",
  "intentSchemaVersion": 1,
  "transport": "telegram",
  "accountId": "default",
  "receiptTarget": "canonical-target",
  "primaryPlatformMessageId": "telegram-message-id",
  "platformMessageIds": ["all-visible-part-ids"],
  "parts": [],
  "sentAt": "RFC3339",
  "settledAt": "RFC3339"
}
```

The receipt row has a foreign key to the immutable intent and is inserted in one SQLite transaction that validates every intent identity field. Audit exports embed the immutable intent snapshot (job/card/follow-up/idempotency/account/target/session/payload hash/intent time) plus the normalized OpenClaw `MessageReceipt`, including all parts for closeouts split across Telegram messages.

Additional uniqueness:

- One settled receipt per `intentId`
- `UNIQUE(transport, account_id, receipt_target, platform_message_id)` for every visible platform ID
- Identical replay is a no-op; conflicting platform evidence fails closed

### 4. Use a dedicated lifecycle plugin command/controller path

Do not expose arbitrary caller-supplied receipt JSON or a generic public `--receipt-file` flag.

A narrow plugin command/controller, using only typed SDK/runtime surfaces, must:

1. Validate the exact canonical lifecycle, follow-up, Workboard, Linear, and source-session links.
2. Create or replay the immutable SQLite intent.
3. Invoke a host-provided durable-send SDK facade that internally routes through `runMessageAction` with:
   - `forceCoreDelivery: true`
   - `requireQueuePersistence: true`
   - stable `deliveryIntentId`
   - `deliveryCompletion: { kind: "plugin", pluginId, ownerType, ownerVersion, payload: { intentId } }`
4. Return the durable lifecycle-closeout operation state, not an untrusted caller-shaped receipt.

The host facade must use the current internal reconciliation-preflight opt-out only to distinguish **required queue persistence** from a false claim that Telegram supports exact unknown-send reconciliation. It must not weaken the queue's `unknown_after_send` no-replay behavior. The core queue path—not the normal Telegram plugin action and not `message_sent`—owns send settlement.

### 5. Durable state machine and settlement order

The lifecycle store records these guarded states:

| State                 | Writer                                                             | Recovery / allowed transition                                                                                                               |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent_committed`    | lifecycle controller                                               | Reconcile deterministic `deliveryIntentId=intentId`; if no queue entry and no attempt marker exists, create/get the one fenced queue entry. |
| `queued`              | completion owner after durable queue creation                      | Resume the existing queue entry; never create a second intent ID.                                                                           |
| `dispatch_started`    | queue/owner projection                                             | Provider outcome may be ambiguous; no blind resend.                                                                                         |
| `receipt_settled`     | completion owner from a fully successful terminal batch settlement | Replay projections only.                                                                                                                    |
| `manual_reconciled`   | explicit approved reconciliation command                           | Replay projections only; provenance remains distinct from queue settlement.                                                                 |
| `projections_pending` | lifecycle projector                                                | Reconcile lifecycle/follow-up/Workboard from authority; never send.                                                                         |
| `workboard_finalized` | trusted Workboard finalizer                                        | Permit canonical lifecycle completion.                                                                                                      |
| `completed`           | lifecycle controller                                               | Terminal; exact replay only.                                                                                                                |
| `rejected_pre_io`     | completion owner                                                   | Permanent terminal pre-I/O rejection; no retry.                                                                                             |
| `retryable_not_sent`  | queue failure state; no terminal owner transition                  | Retry the same deterministic queue intent under the existing bounded policy.                                                                |
| `delivery_uncertain`  | completion owner/recovery                                          | Terminal with respect to automatic Telegram send.                                                                                           |

Order:

1. Validate linked lifecycle identity under per-intent serialization and commit immutable intent with deterministic queue intent ID.
2. Create/get the fenced queue entry containing the generic completion owner. Crash before enqueue leaves `intent_committed`; recovery queries the deterministic queue ID and may create it only when no queue/attempt evidence exists. Crash after enqueue but before the lifecycle projection reuses the existing queue entry.
3. Mark platform dispatch before provider I/O.
4. If Telegram returns identified delivery evidence, persist queue post-send state.
5. After all payload outcomes are terminal, compare the expected rendered-part plan with identified results. Only a fully successful visible batch builds one normalized aggregate receipt and settles it synchronously through the resolved completion owner **before queue acknowledgement**. Any failed-after-send or partial batch becomes `unknown_after_send`/`delivery_uncertain`, even when some message IDs exist.
6. Acknowledge the queue.
7. Idempotently project `intentId`/`receiptId` to the canonical lifecycle view and active follow-up; only the projector may set `visibleCloseoutSent=true`.
8. Workboard finalizer reads the lifecycle store directly and moves only the exact linked card to `done`.
9. Mark lifecycle completed only from `workboard_finalized`. Linear/session projection failures remain retryable and cannot erase receipt evidence.

If projection fails after receipt settlement, recovery resumes at step 7. It never resends Telegram.

### 6. Unknown-outcome policy

| State                                          | Automatic action                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Intent absent                                  | Create intent; do not send yet                                                                         |
| Intent committed, no provider attempt          | One queue-owned attempt allowed                                                                        |
| Retryable provider failure proven before I/O   | Retain and retry the same queue intent under existing bounded queue policy; do not mark owner rejected |
| Permanent pre-I/O rejection                    | `rejected_pre_io`; terminal, no retry                                                                  |
| Attempt started/dispatched, no settled receipt | `delivery_uncertain`; no blind resend                                                                  |
| Receipt settled, projection incomplete         | Replay projections only                                                                                |
| Receipt conflict or multiple identities        | Block for manual investigation                                                                         |
| Workboard incomplete with settled receipt      | Replay exact-card finalization only                                                                    |

Automatic resend after ambiguity is allowed only if the channel supplies authoritative, intent-bound `not_sent` reconciliation. Telegram does not currently provide this capability.

Manual reconciliation is a separate append-only `manual_reconciled` disposition and is never represented as `openclaw.durable-delivery-completion`. It requires explicit Kevin approval and immutable evidence binding the exact intent ID, transport, sending bot account, canonical target/chat, rendered message content and payload hash, every multipart platform message ID/part, source session where applicable, evidence artifact/reference, verifier identity, approval reference, and timestamp. Unavailable, incomplete, or mismatched evidence stays `delivery_uncertain`. A manually reconciled disposition may unlock projections only through the same trusted validator and retains its distinct provenance permanently.

### 7. Workboard is a projection

The Workboard adapter/finalizer:

- accepts `intentId`, not receipt JSON;
- reads the lifecycle-closeout SQLite authority;
- verifies exact `jobId`, `workboardTaskId`, receipt status, and projection generation;
- performs no `list` or `move` operation before evidence validation;
- writes one idempotent finalization marker after the exact card reaches `done`.

A card already at `done` without matching receipt authority is drift and must be surfaced, not accepted.

### 8. Legacy records

For `visibleCloseoutSent=true` without verified transport evidence:

- preserve the historical claim;
- classify it as `legacy_visible_claim_unverified` / `delivery_uncertain`;
- set `resendForbidden=true`;
- do not synthesize a receipt or silently close Workboard/Linear;
- reconcile only from exact platform evidence;
- otherwise require explicit manual disposition.

Migration is idempotent by legacy record ID and migration version.

## Rejected alternatives

### `message_sent` plugin journal

Rejected: observation-only, fire-and-forget, droppable on process exit, and cannot gate queue acknowledgement or lifecycle completion.

### Wrapper script after `openclaw message send --json`

Rejected: crash after provider acceptance/CLI result but before local write leaves unprovable delivery and duplicate risk.

### `onCommitReceipt` as the sole authority

Rejected as the primary queue owner: it is awaited by `sendDurableMessageBatch`, but it runs outside the serializable queue completion/recovery owner and can occur after queue-owned send work. It may be used for projections only after authoritative settlement.

### Telegram sent-message cache

Rejected: short-lived, best-effort, and lacks lifecycle identity and absence proof.

### External outbox/CDC service

Rejected: duplicates OpenClaw’s durable queue, adds infrastructure, and does not make Telegram provider sends idempotent or queryable.

## Revised NAC-78 acceptance proposal

Keep criteria 1–11. Replace delivery criteria 12–18 with:

12. A Kevin-visible Telegram closeout cannot set `visibleCloseoutSent`, move Workboard to `done`, or complete the lifecycle unless either (a) a queue-owned provider receipt with concrete aggregate platform identity is durably settled and linked, or (b) an explicitly Kevin-approved `manual_reconciled` disposition with complete intent-bound evidence is durably recorded with distinct provenance.
13. Internal generation, transcript writes, send requests, CLI acceptance without durable settlement, `message_sent` hooks, and caller-provided receipt JSON are not delivery proof.
14. The immutable lifecycle closeout intent is persisted before provider I/O and binds job, Workboard card, follow-up, account, canonical target, source session, payload hash, and idempotency key.
15. OpenClaw’s durable queue owns the attempt and awaited, generic restart-resolvable completion protocol. Only a fully successful terminal visible batch may settle an aggregate receipt before queue acknowledgement during live delivery and recovery; partial delivery remains uncertain and blocked.
16. Proven pre-I/O failures may use bounded queue retry. An attempt that may have reached Telegram but lacks settled evidence remains `delivery_uncertain` and is not automatically resent without authoritative `not_sent` reconciliation.
17. Workboard, active-followup, Linear, and session updates are idempotent projections from the lifecycle-closeout authority. Projection replay never resends Telegram.
18. Regression tests cover crashes at every boundary, forged/mismatched receipts, multipart Telegram delivery, duplicate callbacks/projectors, legacy visible claims without evidence, and an ambiguous Telegram attempt that remains blocked without duplicate delivery.
19. Human verification proves (a) one successful queue-owned, receipt-linked closeout, (b) one ambiguous Telegram handoff with insufficient evidence that remains `delivery_uncertain`/blocked and produces no resend, and, if manual reconciliation is implemented, (c) one separately witnessed, evidence-bound `manual_reconciled` path that also produces no resend.

## Test requirements for a future implementation

- RED/GREEN tests for immutable intent creation and conflict rejection
- Queue entry contains serializable lifecycle completion owner before provider I/O
- Generic completion owner resolves after restart; missing/incompatible owner blocks acknowledgement
- Full ordered results produce one aggregate receipt containing every multipart platform ID
- Partial delivery with any successful IDs plus failed/missing expected parts remains `delivery_uncertain` and cannot settle a receipt
- Provider identity settles aggregate receipt before queue acknowledgement
- Recovery invokes the same settlement owner
- Crash between intent commit and queue creation reuses the deterministic queue intent and never creates a second send
- Permanent pre-I/O rejection is terminal; retryable proven-not-sent failure retains the same queue intent without an owner rejection
- Crash after provider identity but before projection replays projection only
- Unknown-after-send Telegram entry is never blindly replayed
- Multipart receipt stores every platform message ID
- Forged caller receipt cannot trigger Workboard reads or writes
- Exact replay produces one receipt, one visible projection, one Workboard finalization, and no resend
- Legacy visible claim remains blocked without evidence
- Manual evidence missing account/target/payload/part/provenance approval stays blocked and cannot masquerade as queue settlement
- Power-loss/restart tests against the SQLite store and queue recovery
- Full outbound, Telegram action, Workboard, lifecycle, and Agent Loop regression suites
- Independent spec review and code-quality review before any application proposal

## Activation constraints

This ADR authorizes no implementation, package change, installation, Gateway restart, live canary, external send, Workboard/Linear completion, fallback-search activation, push, merge, deployment, or schedule change.

A future implementation requires explicit scoped approval for OpenClaw core/package changes. NAC-78 remains `In Progress` until the revised acceptance proposal is approved and a fresh implementation passes all gates.
