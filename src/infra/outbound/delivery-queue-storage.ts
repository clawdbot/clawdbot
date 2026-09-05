// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
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
  getDeliveryQueueEntryOwners,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  reserveDeliveryQueueEntryAttempt,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  upsertDeliveryQueueEntryInDatabase,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import {
  claimDeliveryPlatformSendAttempt,
  markOwnedDeliveryPlatformSendDispatched,
} from "./delivery-queue-platform-lease.js";
import {
  StableDeliveryPreparationLostError,
  type StableDeliveryPreparation,
} from "./delivery-queue-preparation.js";
import type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  DeliveryFailureSettlement,
  QueuedDelivery,
  QueuedDeliveryPayload,
} from "./delivery-queue-types.js";
import {
  acceptedPreparedOutboundEntries,
  createUnmodifiedPreparedOutboundBatch,
  projectPreparedOutboundBatchForStorage,
  type PreparedOutboundBatch,
} from "./prepared-batch.js";

export { ackDelivery } from "./delivery-queue-ack.js";

export type {
  LegacyQueuedDelivery,
  LegacyQueuedDeliveryPreparation,
  QueuedDelivery,
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-types.js";

const queuedDeliveryPayloads = (entry: QueuedDelivery) =>
  acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload);

const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "prepared", retired: false },
  { queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, namespace: "preparing", retired: true },
  { queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, namespace: "migration", retired: true },
  {
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    namespace: "legacy-preparing",
    retired: true,
  },
  { queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "legacy", retired: true },
] as const;

export function findDeliveryIntentOwner(id: string, stateDir?: string) {
  const owners = getDeliveryQueueEntryOwners(
    OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.map(({ queueName }) => queueName),
    id,
    stateDir,
  );
  for (const descriptor of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
    const owner = owners.get(descriptor.queueName);
    if (owner) {
      return { ...descriptor, ...owner };
    }
  }
  return null;
}

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
  retainOnFailure: boolean,
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
    reply: params.reply,
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
    ...(retainOnFailure ? { retainOnFailure: true as const } : {}),
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
  const entry = createQueuedDelivery(
    params,
    id,
    params.deliveryCompletion !== undefined || params.completionRetention !== undefined,
  );
  if (mediaStageId) {
    const result = commitStagedDeliveryQueueEntryOnceAcrossNamespaces({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      stagingId: mediaStageId,
      stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
      conflictQueueNames: [],
      stateDir,
    });
    if (result === "missing") {
      throw new Error(`Delivery queue media stage expired before enqueue: ${mediaStageId}`);
    }
    if (result === "existing") {
      throw new Error(`Delivery queue entry already exists: ${OUTBOUND_DELIVERY_QUEUE_NAME}/${id}`);
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
  const entry = createQueuedDelivery(params, normalizedId, true);
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
  const entry = createQueuedDelivery(params, normalizedId, true);
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

const lostPlatformClaim = (id: string) => new Error(`Delivery platform claim was lost: ${id}`);

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

/** Restore the exact pre-attempt row when lifecycle closure wins before provider dispatch. */
export function restoreDeliveryAttemptBeforeDispatch(
  entry: QueuedDelivery,
  reservedAttemptCount: number,
  stateDir?: string,
  claimedAttemptId?: string,
): void {
  updateQueuedDelivery(
    entry.id,
    stateDir,
    (current) => {
      if (current.attemptCount !== reservedAttemptCount) {
        throw new Error(`Delivery attempt reservation changed before rollback: ${entry.id}`);
      }
      return {
        ...current,
        attemptCount: entry.attemptCount,
        availableAt: entry.availableAt,
        producerClaimId: entry.producerClaimId,
        platformSendAttemptId: entry.platformSendAttemptId,
        platformSendStartedAt: entry.platformSendStartedAt,
        effectiveReplyToId: entry.effectiveReplyToId,
        recoveryState: entry.recoveryState,
      };
    },
    claimedAttemptId ?? null,
  );
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
      (entry, database) => {
        upsertDeliveryQueueEntryInDatabase(
          {
            queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
            entry: update(entry as QueuedDelivery),
          },
          database,
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

/** Failed settlement retains owner metadata, but is never eligible for sending. */
export async function loadUnfinishedDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    stateDir,
    "unfinished",
  ) as QueuedDelivery[]; // SAFETY: Pending and unfinished rows in this namespace retain the prepared payload.
}

export async function loadUnfinishedDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
    "unfinished",
  ) as QueuedDelivery | null; // SAFETY: Pending and unfinished rows in this namespace retain the prepared payload.
}

export function hasActiveDeliveryOwner(entry: DeliveryQueueEntryState, now: number): boolean {
  return (
    (typeof entry.completionRetention === "object" ||
      entry.completionRetention === "permanent" ||
      entry.requiresProducerClaim === true) &&
    (entry.recoveryState === "producer_claimed" ||
      ((entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
        entry.requiresProducerClaim === true)) &&
    typeof entry.availableAt === "number" &&
    entry.availableAt > now
  );
}

/** Close send custody before awaiting an owner projection; retain its restart work. */
export async function stageDeliveryFailureSettlement(
  entry: QueuedDelivery,
  settlement: DeliveryFailureSettlement,
  stateDir?: string,
  claimedAttemptId?: string,
): Promise<QueuedDelivery | undefined> {
  if (entry.settlement) {
    const current = loadDeliveryQueueEntry(
      OUTBOUND_DELIVERY_QUEUE_NAME,
      entry.id,
      stateDir,
      "unfinished",
    );
    return current && JSON.stringify(current) === JSON.stringify(entry)
      ? (current as QueuedDelivery) // SAFETY: Exact serialized equality with the typed entry preserves its shape.
      : undefined;
  }
  const reclaim = entry.recoveryState === "producer_claimed" && claimedAttemptId === undefined;
  const attemptId = reclaim
    ? await claimDeliveryPlatformSendAttempt(entry.id, stateDir)
    : (claimedAttemptId ?? entry.platformSendAttemptId ?? null);
  if (reclaim && !attemptId) {
    return undefined;
  }
  let staged: QueuedDelivery | undefined;
  transitionOwnedDeliveryQueueEntry(
    {
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      stateDir,
      platformSendAttemptId: attemptId ?? null,
    },
    (current, database) => {
      // A platform owner may renew after the scan snapshot. Only an explicitly
      // held/reclaimed claim may settle an active lease; reread under the CAS lock.
      if (
        !reclaim &&
        claimedAttemptId === undefined &&
        hasActiveDeliveryOwner(current, Date.now())
      ) {
        return;
      }
      // SAFETY: The owned pending row is in the prepared outbound namespace, before terminal compaction.
      staged = { ...(current as QueuedDelivery), recoveryState: "settlement_pending", settlement };
      upsertDeliveryQueueEntryInDatabase(
        {
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: staged,
          status: "failed",
          updatePendingOnly: true,
        },
        database,
      );
    },
  );
  return staged;
}

/** Only the exact unfinished settlement may compact and publish its terminal facts. */
export function finalizeDeliveryFailureSettlement(
  entry: QueuedDelivery,
  stateDir?: string,
): boolean {
  return (
    terminalizePendingDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      entry,
      stateDir,
      expectedStatus: "failed",
    }).status === "terminalized"
  );
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
): Promise<string[]> {
  const entry = await loadPendingDelivery(id, stateDir);
  if (!entry) {
    throw new Error(`No pending outbound delivery queue entry ${id}`);
  }
  const result = await failPendingDelivery(
    {
      id,
      entry,
      retainSpoolArtifacts: true,
      ...(expectedPlatformSendAttemptId !== undefined ? { expectedPlatformSendAttemptId } : {}),
    },
    stateDir,
  );
  if (result.status !== "failed") {
    throw lostPlatformClaim(id);
  }
  return collectEntrySpoolPaths(queuedDeliveryPayloads(entry), stateDir);
}

type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    entry: QueuedDelivery;
    retainSpoolArtifacts?: boolean;
    expectedPlatformSendAttemptId?: string | null;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  const terminal = { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, id: params.id, entry: params.entry };
  // An unmatched claim must remain a no-op; standalone calls validate before opening state.
  const prepared =
    params.expectedPlatformSendAttemptId === undefined
      ? prepareDeliveryQueueTerminalEntry(terminal)
      : undefined;
  const database = openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
  let terminalized = false;
  const terminalize = (): undefined => {
    terminalized =
      terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepared ?? prepareDeliveryQueueTerminalEntry(terminal),
      ).status === "terminalized";
  };
  if (params.expectedPlatformSendAttemptId !== undefined) {
    transitionOwnedDeliveryQueueEntry(
      {
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id: params.id,
        stateDir,
        database,
        platformSendAttemptId: params.expectedPlatformSendAttemptId,
      },
      terminalize,
    );
  } else {
    terminalize();
  }
  if (terminalized) {
    if (params.retainSpoolArtifacts !== true) {
      await releaseSpoolArtifacts(
        collectEntrySpoolPaths(queuedDeliveryPayloads(params.entry), stateDir),
        stateDir,
      );
    }
    return { status: "failed" };
  }
  return { status: "not_pending" };
}
