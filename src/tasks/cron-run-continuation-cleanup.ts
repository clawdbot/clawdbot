/** Removes an idle exact-run continuation through the session lifecycle owner. */
import { setTimeout as sleep } from "node:timers/promises";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue-storage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "./task-status-access.js";

function canRemoveCronRunContinuation(marker: SessionEntry["cronRunContinuation"]): boolean {
  if (!marker || marker.basePersisted !== true) {
    return false;
  }
  if (marker.phase === "ready") {
    return !marker.ownerRunId;
  }
  if (marker.phase !== "continuing" || !marker.ownerRunId) {
    return false;
  }
  // A retired Gateway owner cannot settle this claim; basePersisted above
  // guarantees deleting its exact alias does not discard the stable session.
  const ownerLifecycleGeneration = marker.ownerLifecycleGeneration?.trim();
  return Boolean(
    ownerLifecycleGeneration && ownerLifecycleGeneration !== getAgentEventLifecycleGeneration(),
  );
}

export async function removeCronRunContinuationSessionIfIdle(
  sessionKey: string,
  settledDeliveryId?: string,
): Promise<void> {
  if (
    !parseCronRunScopeSuffix(sessionKey).runId ||
    hasPendingGeneratedMediaTaskForSessionKey(sessionKey)
  ) {
    return;
  }
  const pendingSessionDeliveries = await loadPendingSessionDeliveries();
  if (
    pendingSessionDeliveries.some(
      (entry) =>
        entry.sessionKey === sessionKey &&
        entry.id !== settledDeliveryId &&
        entry.settlementOutcome === undefined &&
        entry.acknowledgedAt === undefined,
    )
  ) {
    return;
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const cfg = getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const entry = loadSessionEntry({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const marker = entry?.cronRunContinuation;
  if (!entry || !canRemoveCronRunContinuation(marker)) {
    return;
  }
  await deleteSessionEntryLifecycleWithRetry({
    agentId,
    entry,
    sessionKey,
    storePath,
  });
}

/**
 * Deletes the exact-run continuation row, retrying a bounded number of times
 * when the deletion races with the still-releasing session work admission.
 *
 * The cron owner releases its `sessionWorkAdmission` immediately before this
 * cleanup runs, but the release can still be observed as "competing work in
 * flight" by the deletion's admission check (see #134373). The admission is
 * released synchronously, so a short retry resolves the race without changing
 * the admission lifecycle.
 */
async function deleteSessionEntryLifecycleWithRetry(params: {
  agentId: string;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const { agentId, entry, sessionKey, storePath } = params;
  const maxAttempts = 5;
  const baseDelayMs = 50;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deleteSessionEntryLifecycle({
        agentId,
        // Exact rows alias the stable cron transcript; the stable row owns archival.
        archiveTranscript: false,
        expectedEntry: entry,
        expectedLifecycleRevision: entry.lifecycleRevision,
        expectedSessionId: entry.sessionId,
        expectedUpdatedAt: entry.updatedAt,
        requireWriteSuccess: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      return;
    } catch (error) {
      const isCompetingWork = isCompetingWorkInFlightError(error);
      if (!isCompetingWork || attempt === maxAttempts) {
        throw error;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}

function isCompetingWorkInFlightError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Cannot delete session while competing work is in flight")
  );
}
