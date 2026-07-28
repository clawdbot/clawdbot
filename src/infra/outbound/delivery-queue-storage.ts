// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import {
  claimDeliveryQueueEntryPlatformSend,
  promoteDeliveryQueueEntryPlatformSend,
  transitionOwnedDeliveryQueueEntry,
} from "../delivery-queue-sqlite-claim.js";
import {
  completeDeliveryQueueEntry,
  commitStagedDeliveryQueueEntry,
  commitStagedDeliveryQueueEntryOnce,
  deleteDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  reserveDeliveryQueueEntryAttempt,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /** Original queue durability policy when known. */
  queuePolicy?: "required" | "best_effort";
  /** Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** Reusable producer intents require one SQLite-fenced platform owner. */
  requiresProducerClaim?: boolean;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  /** Replayable reply payload hook context for recovery and live delivery. */
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
  /** Channel-valid id reserved before enqueue; recovery must reuse it atomically. */
  preparedMessageId?: string;
  /** Serializable owner state finalized by both live delivery and recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** Retain a terminal receipt when the producer may replay this stable intent indefinitely. */
  completionRetention?: DeliveryQueueCompletionRetention;
  /** Producer-specific retry budget; omitted entries use the queue default. */
  maxRetries?: number;
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  attemptCount: number;
  /** A recoverable cross-process pre-provider ownership lease. */
  availableAt?: number;
  /** Fences an active pre-provider lease against reclaimed producer ownership. */
  producerClaimId?: string;
  lastAttemptAt?: number;
  lastError?: string;
  /** Fences the promoted platform attempt independently of clock precision. */
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  /** Canonical reply target after hooks; null records an intentional root send. */
  effectiveReplyToId?: string | null;
  recoveryState?: "producer_claimed" | "send_attempt_started" | "unknown_after_send";
}

function createQueuedDelivery(params: QueuedDeliveryPayload, id: string): QueuedDelivery {
  return {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    ...(params.requiresProducerClaim === true ? { requiresProducerClaim: true } : {}),
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    replyPayloadSendingHook: params.replyPayloadSendingHook,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    preparedMessageId: params.preparedMessageId,
    deliveryCompletion: params.deliveryCompletion,
    completionRetention: params.completionRetention,
    maxRetries: params.maxRetries,
    retryCount: 0,
    attemptCount: 0,
  };
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
  mediaStageId?: string,
): Promise<string> {
  const id = generateSecureUuid();
  const entry = createQueuedDelivery(params, id);
  if (mediaStageId) {
    const committed = commitStagedDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stagingId: mediaStageId,
      stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
      stateDir,
    });
    if (!committed) {
      throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
    }
  } else {
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stateDir,
    });
  }
  return id;
}

/** Inserts one stable queue id without replacing prior pending or completed ownership. */
export async function enqueueDeliveryOnce(
  params: QueuedDeliveryPayload,
  id: string,
  stateDir?: string,
  mediaStageId?: string,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Stable delivery queue id is required");
  }
  const entry = createQueuedDelivery(params, normalizedId);
  const created = mediaStageId
    ? (() => {
        const result = commitStagedDeliveryQueueEntryOnce({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry,
          stagingId: mediaStageId,
          stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          stateDir,
        });
        if (result === "missing") {
          throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
        }
        return result === "created";
      })()
    : upsertDeliveryQueueEntry({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        entry,
        stateDir,
        insertOnly: true,
      });
  return { id: normalizedId, created };
}

/** Spool artifacts a pending row still references; empty once it is gone or unreadable. */
function loadEntrySpoolPaths(id: string, stateDir: string | undefined): string[] {
  const entry = loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
  return entry ? collectEntrySpoolPaths(entry.payloads, stateDir) : [];
}

type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

function lostPlatformClaim(id: string): Error {
  return new Error(`Stable delivery platform claim was lost: ${id}`);
}

/** Remove a successfully delivered entry, or retain its producer-owned receipt. */
export async function ackDelivery(
  id: string,
  stateDir?: string,
  options?: AckDeliveryOptions,
): Promise<void> {
  // Read the media references before the row goes, then unlink only after the
  // delete commits. A crash in between leaves an orphan for the retention sweep;
  // unlinking first could strip media from a row that still has to replay.
  let spoolPaths: string[] = [];
  const settle = (current: QueuedDelivery | null): void => {
    spoolPaths = current ? collectEntrySpoolPaths(current.payloads, stateDir) : [];
    if (current?.completionRetention && options?.suppressCompletionReceipt !== true) {
      completeDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
    } else {
      deleteDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
    }
  };
  if (options && "expectedPlatformSendAttemptId" in options) {
    const settled = transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        platformSendAttemptId: options.expectedPlatformSendAttemptId ?? null,
      },
      (entry) => settle(entry as QueuedDelivery),
    );
    if (!settled) {
      throw lostPlatformClaim(id);
    }
  } else {
    settle(
      loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir) as QueuedDelivery | null,
    );
  }
  if (!options?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      retryCount: entry.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
    }),
    expectedPlatformSendAttemptId,
  );
}

/** Record a failed attempt whose retry provably cannot duplicate a recipient-visible send. */
export async function failDeliveryBeforePlatformSend(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      retryCount: entry.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
      // Clear both fields together; retaining either would preserve false send evidence.
      availableAt: undefined,
      producerClaimId: undefined,
      platformSendAttemptId: undefined,
      platformSendStartedAt: undefined,
      recoveryState: undefined,
    }),
    expectedPlatformSendAttemptId,
  );
}

/** Record a failed attempt without losing evidence that platform delivery may have completed. */
export async function failDeliveryAfterPlatformSend(
  id: string,
  error: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      retryCount: entry.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
      availableAt: undefined,
      producerClaimId: undefined,
      platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
      recoveryState: "unknown_after_send",
    }),
    expectedPlatformSendAttemptId,
  );
}

/** Atomically transfer a stable pending producer intent to one platform sender. */
export async function claimDeliveryPlatformSendAttempt(
  id: string,
  stateDir?: string,
  reconciledPlatformSendStartedAt?: number,
  reconciledPlatformSendAttemptId?: string,
): Promise<string | undefined> {
  return claimDeliveryQueueEntryPlatformSend({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    ...(reconciledPlatformSendStartedAt !== undefined ? { reconciledPlatformSendStartedAt } : {}),
    ...(reconciledPlatformSendAttemptId !== undefined ? { reconciledPlatformSendAttemptId } : {}),
  });
}

/** Reserve one durable delivery call before invoking the provider path. */
export async function reserveDeliveryAttempt(
  id: string,
  maxAttempts: number,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string,
) {
  return reserveDeliveryQueueEntryAttempt({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    maxAttempts,
    stateDir,
    ...(expectedPlatformSendAttemptId ? { expectedPlatformSendAttemptId } : {}),
  });
}

function updateQueuedDelivery(
  id: string,
  stateDir: string | undefined,
  update: (entry: QueuedDelivery) => QueuedDelivery,
  expectedPlatformSendAttemptId?: string | null,
): void {
  if (expectedPlatformSendAttemptId !== undefined) {
    const updated = transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        platformSendAttemptId: expectedPlatformSendAttemptId,
      },
      () => {
        updateDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir, (entry) =>
          update(entry as QueuedDelivery),
        );
      },
    );
    if (!updated) {
      throw lostPlatformClaim(id);
    }
    return;
  }
  updateDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir, (entry) =>
    update(entry as QueuedDelivery),
  );
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
  producerClaimId?: string,
): Promise<void> {
  if (producerClaimId) {
    const promoted = promoteDeliveryQueueEntryPlatformSend({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id,
      claimId: producerClaimId,
      stateDir,
      route,
    });
    if (!promoted) {
      throw new Error(`Stable delivery platform claim was lost: ${id}`);
    }
    return;
  }
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    availableAt: undefined,
    producerClaimId: undefined,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

/** Refresh the attempt timestamp before recipient-visible or finalizing platform I/O. */
export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      // Dispatch still belongs to the promoted producer until provider I/O
      // settles; clearing its lease lets another process replay an active send.
      availableAt: expectedPlatformSendAttemptId ? entry.availableAt : undefined,
      producerClaimId: undefined,
      platformSendStartedAt: Date.now(),
      ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
      recoveryState: "send_attempt_started",
    }),
    expectedPlatformSendAttemptId,
  );
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      availableAt: undefined,
      producerClaimId: undefined,
      platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
      recoveryState: "unknown_after_send",
    }),
    expectedPlatformSendAttemptId,
  );
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
}

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(
  id: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
): Promise<void> {
  // Dead-lettered rows are retained but never replayed: recovery loads the
  // pending set only, so a failed row's media has no remaining reader.
  let spoolPaths: string[];
  if (expectedPlatformSendAttemptId !== undefined) {
    spoolPaths = [];
    const moved = transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        platformSendAttemptId: expectedPlatformSendAttemptId,
      },
      (entry) => {
        spoolPaths = collectEntrySpoolPaths((entry as QueuedDelivery).payloads, stateDir);
        moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
      },
    );
    if (!moved) {
      throw lostPlatformClaim(id);
    }
  } else {
    spoolPaths = loadEntrySpoolPaths(id, stateDir);
    moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);
  }
  await releaseSpoolArtifacts(spoolPaths, stateDir);
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    expectedStatus: "pending";
    lastError: string;
    entry: QueuedDelivery;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  let result: FailPendingDeliveryResult = { status: "not_pending" };
  const attemptId =
    typeof params.entry.completionRetention === "object" ||
    params.entry.requiresProducerClaim === true
      ? null
      : undefined;
  if (attemptId !== undefined) {
    transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id: params.id,
        stateDir,
        platformSendAttemptId: attemptId,
      },
      () => {
        result = failPendingDeliveryQueueEntry({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          ...params,
          stateDir,
        });
      },
    );
  } else {
    result = failPendingDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      ...params,
      stateDir,
    });
  }
  // Only the writer that won the guarded transition owns the media; a
  // not_pending result means another path holds the row and its artifacts.
  if (result.status === "failed") {
    await releaseSpoolArtifacts(collectEntrySpoolPaths(params.entry.payloads, stateDir), stateDir);
  }
  return result;
}
