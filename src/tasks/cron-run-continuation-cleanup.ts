/** Removes an idle exact-run continuation through the session lifecycle owner. */
import { getRuntimeConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { loadPendingSessionDeliveries } from "../infra/session-delivery-queue.js";
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
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
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
}
