// One-time retirement of pre-D4 pending rows. Canonical recovery reads only prepared rows.
import { failPendingDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import { failDurableDeliveryIfPresent } from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import { LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-media-staging.js";
import type { RecoveryLogger } from "./delivery-queue-recovery.js";
import {
  loadLegacyPendingDeliveries,
  type LegacyQueuedDelivery,
} from "./delivery-queue-storage.js";

type LegacyRetirementSummary = {
  retired: number;
  skipped: number;
  completionUnknownFailed: number;
  mediaCleanupDeferred: number;
};

function retireLegacyPendingEntry(params: {
  entry: LegacyQueuedDelivery;
  stateDir?: string;
}): boolean {
  const { entry } = params;
  return (
    failPendingDeliveryQueueEntry({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      id: entry.id,
      expectedStatus: "pending",
      lastError: "pre-D4 pending outbound delivery retired during upgrade",
      entry,
      // The failed row remains an idempotency owner without retaining raw
      // pre-policy payloads, hook context, or provider-attempt details.
      failedEntry: {
        id: entry.id,
        enqueuedAt: entry.enqueuedAt,
        retryCount: entry.retryCount,
        attemptCount: entry.attemptCount,
        ...(entry.completionRetention ? { completionRetention: entry.completionRetention } : {}),
        recoveryState: "retired_pre_d4_pending",
      },
      stateDir: params.stateDir,
    }).status === "failed"
  );
}

/**
 * Discards pre-D4 pending sends without hooks, provider I/O, or replay. The
 * guarded SQLite transition chooses one startup owner; cleanup happens only
 * after the payload-free terminal row is authoritative.
 */
export async function retireLegacyPendingOutboundDeliveries(params: {
  log: RecoveryLogger;
  stateDir?: string;
}): Promise<LegacyRetirementSummary> {
  // `outbound` is the only tagged pre-D4 namespace. Unreleased D4 checkpoint
  // namespaces are deliberately not upgrade inputs; recognizing them would
  // restore the migration machinery this bounded retirement replaces.
  const summary: LegacyRetirementSummary = {
    retired: 0,
    skipped: 0,
    completionUnknownFailed: 0,
    mediaCleanupDeferred: 0,
  };
  for (const entry of loadLegacyPendingDeliveries(params.stateDir)) {
    const spoolPaths = collectEntrySpoolPaths(entry.payloads ?? [], params.stateDir);
    if (entry.deliveryCompletion) {
      try {
        // Existing owners become unknown before their pointer is scrubbed. A
        // confirmed missing owner is already terminal and must not be recreated.
        failDurableDeliveryIfPresent(entry.deliveryCompletion);
      } catch {
        summary.completionUnknownFailed += 1;
        summary.skipped += 1;
        continue;
      }
    }
    if (!retireLegacyPendingEntry({ entry, stateDir: params.stateDir })) {
      summary.skipped += 1;
      continue;
    }
    summary.retired += 1;
    try {
      await releaseSpoolArtifacts(spoolPaths, params.stateDir);
    } catch {
      // The terminal row no longer retains the path, so orphan GC owns retry.
      summary.mediaCleanupDeferred += 1;
    }
  }
  if (
    summary.retired > 0 ||
    summary.skipped > 0 ||
    summary.completionUnknownFailed > 0 ||
    summary.mediaCleanupDeferred > 0
  ) {
    params.log.info(
      `Retired legacy outbound deliveries retired=${summary.retired} skipped=${summary.skipped} completion_unknown_failed=${summary.completionUnknownFailed} media_cleanup_deferred=${summary.mediaCleanupDeferred}`,
    );
  }
  return summary;
}
