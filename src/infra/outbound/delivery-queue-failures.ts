// Outbound failed-row policy, cleanup finalization, and guarded resubmit.
import type { DeliveryFailureResubmitReason } from "../../../packages/gateway-protocol/src/index.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  compactFailedDeliveryQueueEntryInDatabase,
  loadFailedDeliveryRowInDatabase,
  loadRetainedFailedDeliveryEntries,
  openDeliveryFailureDatabase,
  updateFailedDeliveryQueueEntryPolicyInDatabase,
} from "../delivery-queue-failures.js";
import {
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntryAnyStatus,
  upsertDeliveryQueueEntry,
} from "../delivery-queue-sqlite.js";
import type {
  DeliveryQueueTerminalPolicy,
  DeliveryQueueTerminalReason,
} from "../delivery-queue-sqlite.types.js";
import {
  deliveryTerminalFence,
  parseDeliveryQueueTerminalPolicy,
  parseTerminalPolicyFromEntryJson,
} from "../delivery-queue-terminal-policy.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import {
  collectEntrySpoolPaths,
  findUnavailableReplayMedia,
  releaseSpoolArtifactsStrict,
} from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRecoveryLease,
  createDeliveryQueueMediaRecoveryLease,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import type { LegacyQueuedDelivery, QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export { outboundFailureRetainsMedia } from "./delivery-queue-media-policy.js";

export const queuedDeliveryPayloads = (entry: QueuedDelivery) =>
  acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload);

/** Canonical outbound failures whose durable owner still owes owner or media cleanup. */
export function loadPendingOutboundFailedDeliveryFinalizations(
  stateDir?: string,
  id?: string,
): QueuedDelivery[] {
  return loadRetainedFailedDeliveryEntries([OUTBOUND_DELIVERY_QUEUE_NAME], stateDir, id).flatMap(
    (entry) => {
      const candidate = entry as Partial<QueuedDelivery>;
      const policy = parseDeliveryQueueTerminalPolicy(candidate.terminalPolicy);
      if (
        policy?.detail !== "full" ||
        policy.payload !== "present" ||
        policy.replay !== "owner-managed" ||
        policy.cleanup === "complete" ||
        typeof candidate.id !== "string" ||
        typeof candidate.channel !== "string" ||
        typeof candidate.to !== "string" ||
        candidate.deliveryCompletion === undefined
      ) {
        return [];
      }
      try {
        queuedDeliveryPayloads(candidate as QueuedDelivery);
        return [candidate as QueuedDelivery];
      } catch {
        return [];
      }
    },
  );
}

/** Releases exact spool custody captured before a successful purge CAS. */
export async function releasePurgedOutboundDeliveryMedia(params: {
  queueName: string;
  entryJson: string;
  stateDir?: string;
}): Promise<void> {
  const parsed = parseTerminalPolicyFromEntryJson(params.entryJson).entry as
    | (QueuedDelivery & Partial<LegacyQueuedDelivery>)
    | undefined;
  if (!parsed) {
    return;
  }
  const payloads = Array.isArray(parsed.payloads)
    ? parsed.payloads
    : parsed.preparedBatch
      ? queuedDeliveryPayloads(parsed)
      : [];
  await releaseSpoolArtifactsStrict(
    collectEntrySpoolPaths(payloads, params.stateDir),
    params.stateDir,
  );
}

export function outboundTerminalPolicy(
  entry: QueuedDelivery,
  reason: DeliveryQueueTerminalReason,
): DeliveryQueueTerminalPolicy {
  const ownerManaged = entry.deliveryCompletion !== undefined;
  const evidence = ownerManaged
    ? "owner_managed"
    : entry.recoveryState === "unknown_after_send"
      ? "unknown_after_send"
      : entry.recoveryState === "send_attempt_started"
        ? "send_attempt_started"
        : entry.legacyPreparedContentUnavailable === true
          ? "legacy_unknown"
          : "pre_side_effect";
  const replay = ownerManaged
    ? "owner-managed"
    : evidence === "pre_side_effect"
      ? "safe"
      : "ambiguous";
  const authoredFence = deliveryTerminalFence(
    entry.failureRetention === "none" ? undefined : (entry.failureRetention ?? "permanent"),
  );
  return {
    version: 1,
    detail: "full",
    replay,
    fence: ownerManaged && authoredFence.kind === "none" ? { kind: "permanent" } : authoredFence,
    reason,
    payload: "present",
    cleanup: ownerManaged ? "pending" : "complete",
    evidence,
    ...(ownerManaged ? { owner: "durable_delivery" as const, detailExpiresAt: Date.now() } : {}),
  };
}

type OutboundFailureFinalizationPlan =
  | { kind: "unchanged" }
  | { kind: "changed" }
  | { kind: "owner_media"; entry: QueuedDelivery };

/**
 * Advances one exact failed row, removes owner media only after media ownership is durable,
 * then compacts only after strict idempotent removal succeeds.
 */
export async function finalizeOutboundFailedDelivery(
  id: string,
  stateDir?: string,
  expectedEntry?: QueuedDelivery,
): Promise<boolean> {
  const database = openDeliveryFailureDatabase(stateDir);
  const plan = runSqliteImmediateTransactionSync<OutboundFailureFinalizationPlan>(
    database.db,
    () => {
      const row = loadFailedDeliveryRowInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      if (!row) {
        return { kind: "unchanged" };
      }
      if (expectedEntry && row.entry_json !== JSON.stringify(expectedEntry)) {
        return { kind: "unchanged" };
      }
      const parsed = parseTerminalPolicyFromEntryJson(row.entry_json);
      const policy = parsed.policy;
      if (!parsed.entry || !policy || policy.detail !== "full" || policy.payload !== "present") {
        return { kind: "unchanged" };
      }
      if (policy.replay === "owner-managed") {
        if (policy.cleanup === "complete") {
          return { kind: "unchanged" };
        }
        if (policy.cleanup === "media_pending") {
          return { kind: "owner_media", entry: parsed.entry as QueuedDelivery };
        }
        const mediaPendingPolicy = { ...policy, cleanup: "media_pending" as const };
        const mediaPendingEntry = {
          ...parsed.entry,
          terminalPolicy: mediaPendingPolicy,
        } as QueuedDelivery;
        const changed = updateFailedDeliveryQueueEntryPolicyInDatabase({
          database,
          row,
          entry: parsed.entry,
          policy: mediaPendingPolicy,
          now: Date.now(),
        });
        return changed ? { kind: "owner_media", entry: mediaPendingEntry } : { kind: "unchanged" };
      }
      if (policy.replay === "safe" && policy.detailExpiresAt === undefined) {
        if (policy.cleanup === "complete") {
          return { kind: "unchanged" };
        }
        const finalized = { ...policy, cleanup: "complete" as const };
        const changed = updateFailedDeliveryQueueEntryPolicyInDatabase({
          database,
          row,
          entry: parsed.entry,
          policy: finalized,
          now: Date.now(),
        });
        return changed ? { kind: "changed" } : { kind: "unchanged" };
      }
      const finalized = { ...policy, cleanup: "complete" as const };
      const changed = compactFailedDeliveryQueueEntryInDatabase({
        database,
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        expected: row,
        policy: finalized,
      });
      return changed ? { kind: "changed" } : { kind: "unchanged" };
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "finalize failed outbound delivery",
    },
  );
  if (plan.kind === "unchanged") {
    return false;
  }
  if (plan.kind === "changed") {
    return true;
  }
  const spoolPaths = collectEntrySpoolPaths(queuedDeliveryPayloads(plan.entry), stateDir);
  await releaseSpoolArtifactsStrict(spoolPaths, stateDir);
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const row = loadFailedDeliveryRowInDatabase(database, OUTBOUND_DELIVERY_QUEUE_NAME, id);
      if (!row || row.entry_json !== JSON.stringify(plan.entry)) {
        return false;
      }
      const parsed = parseTerminalPolicyFromEntryJson(row.entry_json);
      if (
        !parsed.policy ||
        parsed.policy.replay !== "owner-managed" ||
        parsed.policy.cleanup !== "media_pending"
      ) {
        return false;
      }
      return compactFailedDeliveryQueueEntryInDatabase({
        database,
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id,
        expected: row,
        policy: { ...parsed.policy, cleanup: "complete" },
      });
    },
    {
      databaseLabel: "openclaw-state",
      operationLabel: "compact cleaned failed outbound delivery",
    },
  );
}

type OutboundDeliveryResubmitResult =
  | { ok: true }
  | { ok: false; reason: DeliveryFailureResubmitReason };

function outboundResubmitRefusal(
  entry: QueuedDelivery | null,
): DeliveryFailureResubmitReason | undefined {
  const policy = parseDeliveryQueueTerminalPolicy(entry?.terminalPolicy);
  if (!entry || !policy || policy.reason === "legacy_unknown") {
    return "legacy_unknown";
  }
  if (policy.detail !== "full") {
    return "compacted";
  }
  if (policy.replay !== "safe" || policy.evidence !== "pre_side_effect") {
    return "ambiguous";
  }
  if (policy.fence.kind !== "none") {
    return "fenced";
  }
  if (entry.deliveryCompletion || entry.requiresProducerClaim === true) {
    return "owner_managed";
  }
  if (
    entry.recoveryState !== undefined ||
    entry.platformSendAttemptId !== undefined ||
    entry.platformSendStartedAt !== undefined ||
    entry.legacyPreparedContentUnavailable === true
  ) {
    return "ambiguous";
  }
  try {
    if (queuedDeliveryPayloads(entry).length === 0) {
      return "missing_payload";
    }
  } catch {
    return "missing_payload";
  }
  return undefined;
}

/** Validates media and atomically resubmits one canonical pre-side-effect outbound failure. */
export async function resubmitOutboundDelivery(
  id: string,
  stateDir?: string,
): Promise<OutboundDeliveryResubmitResult> {
  if (getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir) !== "failed") {
    return { ok: false, reason: "not_failed" };
  }
  const current = loadDeliveryQueueEntryAnyStatus(
    OUTBOUND_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedDelivery | null;
  const refusal = outboundResubmitRefusal(current);
  if (refusal || !current) {
    return { ok: false, reason: refusal ?? "not_found" };
  }
  const payloads = queuedDeliveryPayloads(current);
  const spoolPaths = collectEntrySpoolPaths(payloads, stateDir);
  const leaseId =
    spoolPaths.length > 0 ? createDeliveryQueueMediaRecoveryLease(spoolPaths, stateDir) : undefined;
  try {
    const unavailable = await findUnavailableReplayMedia(payloads, stateDir);
    if (unavailable.length > 0) {
      return { ok: false, reason: "missing_media" };
    }
    return runOpenClawStateWriteTransaction(
      () => {
        if (getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir) !== "failed") {
          return { ok: false, reason: "ownership_changed" };
        }
        const latest = loadDeliveryQueueEntryAnyStatus(
          OUTBOUND_DELIVERY_QUEUE_NAME,
          id,
          stateDir,
        ) as QueuedDelivery | null;
        const latestRefusal = outboundResubmitRefusal(latest);
        if (latestRefusal || !latest || JSON.stringify(latest) !== JSON.stringify(current)) {
          return { ok: false, reason: latestRefusal ?? "ownership_changed" };
        }
        const {
          terminalPolicy: _terminalPolicy,
          lastError: _lastError,
          lastAttemptAt: _lastAttemptAt,
          recoveryState: _recoveryState,
          platformSendAttemptId: _platformSendAttemptId,
          platformSendStartedAt: _platformSendStartedAt,
          producerClaimId: _producerClaimId,
          availableAt: _availableAt,
          ...retained
        } = latest;
        const revived = upsertDeliveryQueueEntry({
          queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
          entry: { ...retained, enqueuedAt: Date.now(), retryCount: 0, attemptCount: 0 },
          stateDir,
          reviveFailedOrCorruptPending: true,
        });
        return revived ? { ok: true } : { ok: false, reason: "ownership_changed" };
      },
      { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
      { operationLabel: "resubmit failed outbound delivery" },
    );
  } finally {
    cancelDeliveryQueueMediaRecoveryLease(leaseId, stateDir);
  }
}
