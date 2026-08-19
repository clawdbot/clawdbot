// One-time pre-D4 queue migration. Normal recovery reads only prepared rows.
import { randomUUID } from "node:crypto";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import {
  movePendingDeliveryQueueEntryNamespace,
  replacePendingDeliveryQueueEntry,
} from "../delivery-queue-sqlite-namespace.js";
import { terminalizePendingDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
} from "./deliver-payload.js";
import { prepareOutboundPayloadBatch } from "./deliver-prepare.js";
import { failDurableDelivery } from "./delivery-completion.js";
import {
  collectEntrySpoolPaths,
  releaseSpoolArtifacts,
  stageQueuePayloadMedia,
} from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { reconcileUnknownQueuedDelivery } from "./delivery-queue-reconciliation.js";
import type { RecoveryLogger } from "./delivery-queue-recovery.js";
import {
  loadLegacyPendingDeliveries,
  loadPendingLegacyDeliveryPreparations,
  loadPendingDeliveryMigrations,
  type LegacyQueuedDelivery,
  type LegacyQueuedDeliveryPreparation,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import {
  acceptedPreparedOutboundEntries,
  createUnavailablePreparedOutboundBatch,
  mapPreparedOutboundAcceptedPayloads,
  projectPreparedOutboundBatchForStorage,
} from "./prepared-batch.js";
import { normalizeOutboundReplyFacts } from "./reply-policy.js";

const LEGACY_PREPARATION_LEASE_MS = 5 * 60_000;
const LEGACY_PREPARATION_LEASE_RENEW_MS = 30_000;

function withLegacyPreparationLease(
  entry: LegacyQueuedDeliveryPreparation,
  ownerId: string,
  now = Date.now(),
): LegacyQueuedDeliveryPreparation {
  return {
    ...entry,
    retainOnFailure: true,
    legacyPreparationOwnerId: ownerId,
    legacyPreparationLeaseExpiresAt: now + LEGACY_PREPARATION_LEASE_MS,
  };
}

function hasActiveLegacyPreparationLease(
  entry: LegacyQueuedDeliveryPreparation,
  now = Date.now(),
): boolean {
  return Boolean(
    entry.legacyPreparationOwnerId &&
    typeof entry.legacyPreparationLeaseExpiresAt === "number" &&
    entry.legacyPreparationLeaseExpiresAt > now,
  );
}

function buildLegacyPreparationParams(entry: LegacyQueuedDelivery, cfg: OpenClawConfig) {
  const reply = normalizeOutboundReplyFacts({
    reply: entry.reply,
    replyToId: entry.replyToId,
    replyToMode: entry.replyToMode,
  });
  return {
    cfg,
    channel: entry.channel,
    to: entry.to,
    accountId: entry.accountId,
    queuePolicy: entry.queuePolicy,
    requireUnknownSendReconciliation: entry.requireUnknownSendReconciliation,
    payloads: entry.payloads,
    renderedBatchPlan: entry.renderedBatchPlan,
    threadId: entry.threadId,
    reply,
    formatting: entry.formatting,
    identity: entry.identity,
    bestEffort: entry.bestEffort,
    gifPlayback: entry.gifPlayback,
    forceDocument: entry.forceDocument,
    replyPayloadSendingHook: entry.replyPayloadSendingHook,
    silent: entry.silent,
    mirror: entry.mirror,
    session: entry.session,
    gatewayClientScopes: entry.gatewayClientScopes,
    preparedMessageId: entry.preparedMessageId,
    deliveryCompletion: entry.deliveryCompletion,
    completionRetention: entry.completionRetention,
    skipQueue: true,
  } as const;
}

async function prepareLegacyEntryCheckpoint(params: {
  entry: LegacyQueuedDeliveryPreparation;
  ownerId: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<"checkpointed" | "skipped"> {
  const preparationParams = buildLegacyPreparationParams(params.entry, params.cfg);
  const reply = preparationParams.reply;
  const needsUnknownReconciliation =
    params.entry.recoveryState === "send_attempt_started" ||
    params.entry.recoveryState === "unknown_after_send";
  const legacyUnknownSendReconciliation = needsUnknownReconciliation
    ? await reconcileUnknownQueuedDelivery({
        entry: { ...params.entry, reply },
        payloads: params.entry.payloads,
        cfg: params.cfg,
        warn: (message) => params.log.warn(message),
      })
    : undefined;
  if (
    needsUnknownReconciliation &&
    (legacyUnknownSendReconciliation == null ||
      legacyUnknownSendReconciliation.status === "unresolved")
  ) {
    // The migration owner has no safe canonical payload to publish and startup
    // recovery does not scan this private namespace. Settle payload-free instead
    // of retaining raw content in a permanently hidden pending row.
    await failInterruptedLegacyPreparation({
      entry: params.entry,
      log: params.log,
      stateDir: params.stateDir,
    });
    return "skipped";
  }
  // Shipped rows did not record whether policy ran. The accepted upgrade policy
  // preserves shipped recovery by allowing one final pass only before any provider
  // evidence; migration then removes the raw owner so policy can never rerun again.
  // Sent or partially-sent legacy custody has no trustworthy post-policy snapshot.
  const prepareForReplay =
    !needsUnknownReconciliation ||
    (params.entry.recoveryState === "send_attempt_started" &&
      legacyUnknownSendReconciliation?.status === "not_sent");
  let sourceEntry = params.entry;
  let preparedBatch;
  if (prepareForReplay) {
    let modifiersStarted = false;
    let leaseLost = false;
    const renewLease = (): void => {
      if (leaseLost) {
        return;
      }
      const renewed = withLegacyPreparationLease(sourceEntry, params.ownerId);
      if (
        !replacePendingDeliveryQueueEntry({
          queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          expectedEntry: sourceEntry,
          replacementEntry: renewed,
          stateDir: params.stateDir,
        })
      ) {
        leaseLost = true;
        return;
      }
      sourceEntry = renewed;
    };
    const renewLeaseSafely = (): void => {
      try {
        renewLease();
      } catch (error) {
        leaseLost = true;
        params.log.warn(
          `Legacy delivery ${params.entry.id} preparation lease renewal failed: ${String(error)}`,
        );
      }
    };
    const leaseTimer = setInterval(renewLeaseSafely, LEGACY_PREPARATION_LEASE_RENEW_MS);
    leaseTimer.unref();
    try {
      preparedBatch = await prepareOutboundPayloadBatch(preparationParams, {
        onBeforeFirstModifier: () => {
          if (leaseLost) {
            throw new Error(`Legacy delivery ${params.entry.id} preparation lease was lost`);
          }
          const startedEntry: LegacyQueuedDeliveryPreparation = {
            ...sourceEntry,
            legacyPreparationState: "modifiers_started",
          };
          if (
            !replacePendingDeliveryQueueEntry({
              queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
              expectedEntry: sourceEntry,
              replacementEntry: startedEntry,
              stateDir: params.stateDir,
            })
          ) {
            throw new Error(`Legacy delivery ${params.entry.id} preparation ownership changed`);
          }
          sourceEntry = startedEntry;
          modifiersStarted = true;
        },
      });
      if (leaseLost) {
        throw new Error(`Legacy delivery ${params.entry.id} preparation lease was lost`);
      }
    } catch (error) {
      clearInterval(leaseTimer);
      if (modifiersStarted) {
        await failInterruptedLegacyPreparation({
          entry: sourceEntry,
          log: params.log,
          stateDir: params.stateDir,
        });
      } else if (!leaseLost) {
        const releasedEntry: LegacyQueuedDeliveryPreparation = {
          ...sourceEntry,
          legacyPreparationOwnerId: undefined,
          legacyPreparationLeaseExpiresAt: undefined,
        };
        replacePendingDeliveryQueueEntry({
          queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
          expectedEntry: sourceEntry,
          replacementEntry: releasedEntry,
          stateDir: params.stateDir,
        });
      }
      throw error;
    }
    clearInterval(leaseTimer);
  } else {
    preparedBatch = createUnavailablePreparedOutboundBatch(params.entry.payloads.length);
  }
  const acceptedPayloads = acceptedPreparedOutboundEntries(preparedBatch).map(
    (entry) => entry.payload,
  );
  const {
    payloads: _legacyPayloads,
    replyPayloadSendingHook: _legacyReplyHook,
    replyToId: _legacyReplyToId,
    replyToMode: _legacyReplyToMode,
    legacyPreparationState: _legacyPreparationState,
    legacyPreparationOwnerId: _legacyPreparationOwnerId,
    legacyPreparationLeaseExpiresAt: _legacyPreparationLeaseExpiresAt,
    ...retained
  } = params.entry;
  let canonicalRetained: typeof retained = retained;
  if (prepareForReplay && needsUnknownReconciliation) {
    const {
      availableAt: _availableAt,
      producerClaimId: _producerClaimId,
      platformSendAttemptId: _platformSendAttemptId,
      platformSendStartedAt: _platformSendStartedAt,
      effectiveReplyToId: _effectiveReplyToId,
      recoveryState: _recoveryState,
      ...resetAttempt
    } = retained;
    // The provider verdict applies only to the shipped attempt. Canonical
    // recovery must create fresh attempt identity before any later send.
    canonicalRetained = resetAttempt;
  }
  const checkpoint: QueuedDelivery = {
    ...canonicalRetained,
    retainOnFailure: true,
    preparedBatch: projectPreparedOutboundBatchForStorage(preparedBatch),
    renderedBatchPlan: createRenderedMessageBatchPlan(acceptedPayloads),
    ...(reply ? { reply } : {}),
    ...(!prepareForReplay &&
    (legacyUnknownSendReconciliation?.status === "sent" ||
      legacyUnknownSendReconciliation?.status === "not_sent")
      ? { legacyUnknownSendReconciliation }
      : {}),
    ...(!prepareForReplay ? { legacyPreparedContentUnavailable: true } : {}),
  };
  const result = movePendingDeliveryQueueEntryNamespace({
    sourceQueueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    destinationQueueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    expectedSourceEntry: sourceEntry,
    destinationEntry: checkpoint,
    stateDir: params.stateDir,
  });
  if (result !== "moved") {
    params.log.warn(`Legacy delivery ${params.entry.id} preparation deferred: ${result}`);
    return "skipped";
  }
  return "checkpointed";
}

async function failInterruptedLegacyPreparation(params: {
  entry: LegacyQueuedDeliveryPreparation;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<void> {
  const failed = terminalizePendingDeliveryQueueEntry({
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    id: params.entry.id,
    entry: params.entry,
    stateDir: params.stateDir,
  });
  if (failed.status !== "terminalized") {
    params.log.warn(`Legacy delivery ${params.entry.id} preparation owner was already settled`);
    return;
  }
  if (params.entry.deliveryCompletion) {
    try {
      await failDurableDelivery(params.entry.deliveryCompletion, params.stateDir);
    } catch (error) {
      params.log.warn(
        `Legacy delivery ${params.entry.id} interrupted preparation owner could not be marked unknown: ${String(error)}`,
      );
    }
  }
  await releaseSpoolArtifacts(
    collectEntrySpoolPaths(params.entry.payloads, params.stateDir),
    params.stateDir,
  ).catch((error: unknown) => {
    params.log.warn(
      `Legacy delivery ${params.entry.id} failed preparation media cleanup failed: ${String(error)}`,
    );
  });
}

function claimLegacyEntryForPreparation(params: {
  entry: LegacyQueuedDelivery;
  ownerId: string;
  stateDir?: string;
}): LegacyQueuedDeliveryPreparation | null {
  const claimed = withLegacyPreparationLease(
    {
      ...params.entry,
      legacyPreparationState: "claimed",
    },
    params.ownerId,
  );
  const result = movePendingDeliveryQueueEntryNamespace({
    sourceQueueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
    destinationQueueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    expectedSourceEntry: params.entry,
    destinationEntry: claimed,
    retainSourceCompletionFence:
      params.entry.requiresProducerClaim === true || params.entry.completionRetention !== undefined,
    stateDir: params.stateDir,
  });
  return result === "moved" ? claimed : null;
}

function reclaimLegacyPreparation(params: {
  entry: LegacyQueuedDeliveryPreparation;
  ownerId: string;
  stateDir?: string;
}): LegacyQueuedDeliveryPreparation | null {
  const claimed = withLegacyPreparationLease(params.entry, params.ownerId);
  return replacePendingDeliveryQueueEntry({
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    expectedEntry: params.entry,
    replacementEntry: claimed,
    stateDir: params.stateDir,
  })
    ? claimed
    : null;
}

async function finalizePreparedMigration(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<"moved" | "skipped"> {
  const acceptedPayloads = acceptedPreparedOutboundEntries(params.entry.preparedBatch).map(
    (entry) => entry.payload,
  );
  const stageForReplay = params.entry.legacyPreparedContentUnavailable !== true;
  let stagedPayloads = acceptedPayloads;
  let mediaStageId: string | undefined;
  let stagedArtifacts: string[] = [];
  if (stageForReplay) {
    const mediaParams = {
      ...params.entry,
      cfg: params.cfg,
      payloads: acceptedPayloads,
      skipQueue: true,
    };
    const staged = await stageQueuePayloadMedia({
      payloads: acceptedPayloads,
      mediaAccess: resolveOutboundMediaAccessForSend(
        mediaParams,
        params.entry.channel,
        collectPayloadMediaSources(acceptedPayloads),
      ),
      maxBytes: resolveOutboundMediaMaxBytes({
        cfg: params.cfg,
        channel: params.entry.channel,
        accountId: params.entry.accountId,
      }),
      stateDir: params.stateDir,
    });
    if (staged.status !== "staged") {
      params.log.warn(
        `Legacy delivery ${params.entry.id} cannot be migrated: ${staged.reason} is not durable`,
      );
      return "skipped";
    }
    stagedPayloads = staged.payloads;
    mediaStageId = staged.mediaStageId;
    stagedArtifacts = staged.artifacts;
  }
  let stagedArtifactsTransferred = false;
  try {
    const queuedPreparedBatch = mapPreparedOutboundAcceptedPayloads(
      params.entry.preparedBatch,
      stagedPayloads,
    );
    const destination: QueuedDelivery = {
      ...params.entry,
      preparedBatch: queuedPreparedBatch,
      // Media staging rewrites only local custody paths. Provider recovery
      // must retain the pre-staging plan used by the original attempt.
      renderedBatchPlan:
        params.entry.renderedBatchPlan ?? createRenderedMessageBatchPlan(acceptedPayloads),
    };
    const result = movePendingDeliveryQueueEntryNamespace({
      sourceQueueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
      destinationQueueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      expectedSourceEntry: params.entry,
      destinationEntry: destination,
      ...(mediaStageId
        ? {
            stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
            stagingId: mediaStageId,
          }
        : {}),
      stateDir: params.stateDir,
    });
    if (result !== "moved") {
      params.log.warn(`Legacy delivery ${params.entry.id} migration deferred: ${result}`);
      return "skipped";
    }
    stagedArtifactsTransferred = true;
    if (stageForReplay) {
      await releaseSpoolArtifacts(
        collectEntrySpoolPaths(acceptedPayloads, params.stateDir),
        params.stateDir,
      ).catch((error: unknown) => {
        params.log.warn(
          `Legacy delivery ${params.entry.id} moved but old media cleanup failed: ${String(error)}`,
        );
      });
    }
    return "moved";
  } finally {
    if (!stagedArtifactsTransferred) {
      cancelDeliveryQueueMediaRetention(mediaStageId, params.stateDir);
      await releaseSpoolArtifacts(stagedArtifacts, params.stateDir);
    }
  }
}

const activeLegacyMigrations = new Map<string, Promise<{ moved: number; skipped: number }>>();

/** Migrates every unchanged pre-D4 pending row before canonical recovery scans. */
export async function migrateLegacyPendingOutboundDeliveries(params: {
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<{ moved: number; skipped: number }> {
  const migrationKey = params.stateDir ?? "<default-state>";
  return await getOrCreatePromise(
    activeLegacyMigrations,
    migrationKey,
    () => migrateLegacyPendingOutboundDeliveriesOwned(params),
    { evictOnSettled: true },
  );
}

async function migrateLegacyPendingOutboundDeliveriesOwned(params: {
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;
  const ownerId = randomUUID();
  const claimedPreparations: LegacyQueuedDeliveryPreparation[] = [];
  for (const entry of loadPendingLegacyDeliveryPreparations(params.stateDir)) {
    if (hasActiveLegacyPreparationLease(entry)) {
      skipped += 1;
      params.log.info(`Legacy delivery ${entry.id} preparation is leased by another owner`);
      continue;
    }
    if (entry.legacyPreparationState !== "claimed") {
      await failInterruptedLegacyPreparation({
        ...params,
        entry,
      });
      skipped += 1;
      continue;
    }
    const claimed = reclaimLegacyPreparation({ entry, ownerId, stateDir: params.stateDir });
    if (!claimed) {
      skipped += 1;
      params.log.info(`Legacy delivery ${entry.id} preparation ownership changed`);
      continue;
    }
    claimedPreparations.push(claimed);
  }
  for (const entry of loadLegacyPendingDeliveries(params.stateDir)) {
    const claimed = claimLegacyEntryForPreparation({
      entry,
      ownerId,
      stateDir: params.stateDir,
    });
    if (!claimed) {
      skipped += 1;
      params.log.warn(`Legacy delivery ${entry.id} could not acquire preparation ownership`);
      continue;
    }
    claimedPreparations.push(claimed);
  }
  for (const entry of claimedPreparations) {
    try {
      if ((await prepareLegacyEntryCheckpoint({ ...params, entry, ownerId })) === "skipped") {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      params.log.warn(`Legacy delivery ${entry.id} migration failed: ${String(error)}`);
    }
  }
  for (const entry of loadPendingDeliveryMigrations(params.stateDir)) {
    try {
      if ((await finalizePreparedMigration({ ...params, entry })) === "moved") {
        moved += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      params.log.warn(`Prepared delivery ${entry.id} migration failed: ${String(error)}`);
    }
  }
  if (moved > 0 || skipped > 0) {
    params.log.info(`Legacy delivery migration settled moved=${moved} skipped=${skipped}`);
  }
  return { moved, skipped };
}
