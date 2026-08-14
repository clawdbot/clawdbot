// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import {
  promoteDeliveryQueueEntryPlatformSend,
  transitionOwnedDeliveryQueueEntry,
  type InitialDeliveryProducerClaim,
} from "../delivery-queue-sqlite-claim.js";
import {
  commitStagedDeliveryQueueEntryOnceAcrossNamespaces,
  movePendingDeliveryQueueEntryNamespace,
  upsertDeliveryQueueEntryOnceAcrossNamespaces,
} from "../delivery-queue-sqlite-namespace.js";
import {
  completeDeliveryQueueEntry,
  commitStagedDeliveryQueueEntry,
  deleteDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  reserveDeliveryQueueEntryAttempt,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
} from "../delivery-queue-sqlite.js";
import type {
  DeliveryQueueFailureRetention,
  DeliveryQueueTerminalPolicy,
  DeliveryQueueTerminalReason,
} from "../delivery-queue-sqlite.types.js";
import { generateSecureUuid } from "../secure-random.js";
import {
  outboundFailureRetainsMedia,
  outboundTerminalPolicy,
  queuedDeliveryPayloads,
} from "./delivery-queue-failures.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { markOwnedDeliveryPlatformSendDispatched } from "./delivery-queue-platform-lease.js";
import {
  StableDeliveryPreparationLostError,
  type StableDeliveryPreparation,
} from "./delivery-queue-preparation.js";
import type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  QueuedDelivery,
  QueuedDeliveryPayload,
} from "./delivery-queue-types.js";
import {
  createUnmodifiedPreparedOutboundBatch,
  projectPreparedOutboundBatchForStorage,
  type PreparedOutboundBatch,
} from "./prepared-batch.js";

export {
  findDeliveryIntentOwner,
  findDeliveryIntentOwners,
  OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS,
} from "./delivery-queue-namespaces.js";
export type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  QueuedDelivery,
  QueuedDeliveryPayload,
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-types.js";

function preparedBatchFromLowLevelInput(params: QueuedDeliveryPayload): PreparedOutboundBatch {
  if (params.preparedBatch) {
    return params.preparedBatch;
  }
  if (!params.payloads) {
    throw new Error("Delivery queue entry requires a prepared payload batch");
  }
  return createUnmodifiedPreparedOutboundBatch(params.payloads);
}

type QueuedDeliveryAdmissionPayload = QueuedDeliveryPayload & {
  initialProducerClaim?: InitialDeliveryProducerClaim;
};

function createQueuedDelivery(
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  failureRetention: DeliveryQueueFailureRetention,
): QueuedDelivery {
  return {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    ...(params.initialProducerClaim ??
      (params.requiresProducerClaim === true ? { requiresProducerClaim: true } : {})),
    preparedBatch: projectPreparedOutboundBatchForStorage(preparedBatchFromLowLevelInput(params)),
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    preparedMessageId: params.preparedMessageId,
    deliveryCompletion: params.deliveryCompletion,
    completionRetention: params.completionRetention,
    failureRetention,
    legacyUnknownSendReconciliation: params.legacyUnknownSendReconciliation,
    legacyPreparedContentUnavailable: params.legacyPreparedContentUnavailable,
    maxRetries: params.maxRetries,
    retryCount: 0,
    attemptCount: 0,
  };
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryAdmissionPayload,
  stateDir?: string,
  mediaStageId?: string,
): Promise<string> {
  const id = generateSecureUuid();
  const entry = createQueuedDelivery(params, id, params.completionRetention ?? "none");
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
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  stateDir?: string,
  mediaStageId?: string,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId) {
    throw new Error("Stable delivery queue id is required");
  }
  const entry = createQueuedDelivery(
    params,
    normalizedId,
    params.completionRetention ?? "permanent",
  );
  const created = mediaStageId
    ? (() => {
        const result = commitStagedDeliveryQueueEntryOnceAcrossNamespaces({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry,
          stagingId: mediaStageId,
          stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          conflictQueueNames: [
            OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
            OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
            LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
          ],
          stateDir,
        });
        if (result === "missing") {
          throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
        }
        return result === "created";
      })()
    : upsertDeliveryQueueEntryOnceAcrossNamespaces({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        conflictQueueNames: [
          OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
          OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
        ],
        entry,
        stateDir,
      });
  return { id: normalizedId, created };
}

/** Atomically replaces a payload-free stable preparation owner with prepared custody. */
export async function enqueuePreparedDeliveryOnce(
  params: QueuedDeliveryAdmissionPayload,
  id: string,
  preparation: StableDeliveryPreparation,
  stateDir?: string,
  mediaStageId?: string,
): Promise<{ id: string; created: boolean }> {
  const normalizedId = id.trim();
  if (!normalizedId || normalizedId !== preparation.id) {
    throw new Error("Stable delivery preparation id is invalid");
  }
  const entry = createQueuedDelivery(
    params,
    normalizedId,
    params.completionRetention ?? "permanent",
  );
  const result = movePendingDeliveryQueueEntryNamespace({
    sourceQueueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
    destinationQueueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    conflictQueueNames: [
      OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
      OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
    ],
    expectedSourceEntry: preparation,
    destinationEntry: entry,
    ...(mediaStageId
      ? {
          stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
          stagingId: mediaStageId,
        }
      : {}),
    stateDir,
  });
  if (result === "staging-missing") {
    throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
  }
  if (result !== "moved") {
    throw new StableDeliveryPreparationLostError(normalizedId);
  }
  return { id: normalizedId, created: true };
}

type AckDeliveryOptions = {
  /** Caller holds a GC-visible recovery lease until its active adapter settles. */
  retainSpoolArtifacts?: boolean;
  /** An intentionally suppressed pre-send batch must not become a success receipt. */
  suppressCompletionReceipt?: boolean;
  /** Prevent an older provider attempt from settling a replacement owner. */
  expectedPlatformSendAttemptId?: string | null;
};

const lostPlatformClaim = (id: string) => new Error(`Delivery platform claim was lost: ${id}`);

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
    spoolPaths = current ? collectEntrySpoolPaths(queuedDeliveryPayloads(current), stateDir) : [];
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
      // The failed attempt has settled. Keep platform evidence for recovery,
      // but release the live owner so another process can reconcile or retry.
      availableAt: undefined,
      producerClaimId: undefined,
      recoveryState: entry.recoveryState === "producer_claimed" ? undefined : entry.recoveryState,
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

export { claimDeliveryPlatformSendAttempt } from "./delivery-queue-platform-lease.js";

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
      throw new Error(`Delivery platform claim was lost: ${id}`);
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
  if (typeof expectedPlatformSendAttemptId === "string") {
    markOwnedDeliveryPlatformSendDispatched(id, stateDir, route, expectedPlatformSendAttemptId);
    return;
  }
  updateQueuedDelivery(
    id,
    stateDir,
    (entry) => ({
      ...entry,
      availableAt: undefined,
      producerClaimId: undefined,
      platformSendStartedAt: Date.now(),
      ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
      // A later batch send must not erase concrete evidence from an earlier result;
      // recovery could otherwise replay the whole batch and duplicate that delivery.
      recoveryState:
        entry.recoveryState === "unknown_after_send" ? entry.recoveryState : "send_attempt_started",
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
      // An explicit live producer keeps its exact lease through the ambiguous
      // outcome so recovery cannot race its remaining cleanup.
      availableAt:
        expectedPlatformSendAttemptId &&
        entry.requiresProducerClaim === true &&
        entry.platformSendAttemptId === expectedPlatformSendAttemptId
          ? entry.availableAt
          : undefined,
      producerClaimId: undefined,
      platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
      recoveryState: "unknown_after_send",
    }),
    expectedPlatformSendAttemptId,
  );
}

/** Load a single pending delivery entry by ID from the queue directory. */
export const loadPendingDelivery = async (
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> =>
  loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir) as QueuedDelivery | null;

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(OUTBOUND_DELIVERY_QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** One-time migration inventory; normal recovery never reads the legacy namespace. */
export function loadLegacyPendingDeliveries(stateDir?: string): LegacyQueuedDelivery[] {
  return loadDeliveryQueueEntries(
    LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
    stateDir,
  ) as LegacyQueuedDelivery[];
}

/** Prepared legacy rows awaiting media staging and canonical publication. */
export function loadPendingDeliveryMigrations(stateDir?: string): QueuedDelivery[] {
  return loadDeliveryQueueEntries(
    OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    stateDir,
  ) as QueuedDelivery[];
}

/** Claimed pre-D4 rows whose modifying policy has not safely published yet. */
export function loadPendingLegacyDeliveryPreparations(
  stateDir?: string,
): LegacyQueuedDeliveryPreparation[] {
  return loadDeliveryQueueEntries(
    OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    stateDir,
  ) as LegacyQueuedDeliveryPreparation[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(
  id: string,
  stateDir?: string,
  expectedPlatformSendAttemptId?: string | null,
  reason: DeliveryQueueTerminalReason = "retry_exhausted",
): Promise<void> {
  // Dead-lettered rows are retained but never replayed: recovery loads the
  // pending set only, so a failed row's media has no remaining reader.
  let spoolPaths: string[];
  let terminalPolicy: DeliveryQueueTerminalPolicy | undefined;
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
        terminalPolicy = outboundTerminalPolicy(entry as QueuedDelivery, reason);
        spoolPaths = collectEntrySpoolPaths(
          queuedDeliveryPayloads(entry as QueuedDelivery),
          stateDir,
        );
        moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, terminalPolicy, stateDir);
      },
    );
    if (!moved) {
      throw lostPlatformClaim(id);
    }
  } else {
    const entry = (await loadPendingDelivery(id, stateDir)) as QueuedDelivery | null;
    if (!entry) {
      throw new Error(`No pending outbound delivery queue entry ${id}`);
    }
    spoolPaths = collectEntrySpoolPaths(queuedDeliveryPayloads(entry), stateDir);
    terminalPolicy = outboundTerminalPolicy(entry, reason);
    moveDeliveryQueueEntryToFailed(OUTBOUND_DELIVERY_QUEUE_NAME, id, terminalPolicy, stateDir);
  }
  if (terminalPolicy && !outboundFailureRetainsMedia(terminalPolicy)) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    expectedStatus: "pending";
    lastError: string;
    entry: QueuedDelivery;
    reason?: DeliveryQueueTerminalReason;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  let result: FailPendingDeliveryResult = { status: "not_pending" };
  const terminalReason = params.reason ?? "admission_rejected";
  const terminalPolicy = outboundTerminalPolicy(params.entry, terminalReason);
  const failedEntry = { ...params.entry, terminalPolicy };
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
          failedEntry,
          stateDir,
        });
      },
    );
  } else {
    result = failPendingDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      ...params,
      failedEntry,
      stateDir,
    });
  }
  // Only the writer that won the guarded transition owns the media; a
  // not_pending result means another path holds the row and its artifacts.
  if (result.status === "failed" && !outboundFailureRetainsMedia(terminalPolicy)) {
    await releaseSpoolArtifacts(
      collectEntrySpoolPaths(queuedDeliveryPayloads(params.entry), stateDir),
      stateDir,
    );
  }
  return result;
}
