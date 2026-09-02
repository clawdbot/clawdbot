/**
 * Sweep handling for runs that are still marked active but have no execution
 * context left — the shape a subagent run is left in when the gateway dies
 * underneath it.
 *
 * Split out of the sweeper so the reap decision, which has to reason about boot
 * history and about who still needs to be told, reads as one thing.
 */
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  countRecordedSubagentAssistantMessages,
  formatSubagentOrphanErrorMessage,
  loadGatewayBootSegmentsForAttribution,
  resolveSubagentOrphanAttribution,
  resolveSubagentRunLastActivityMs,
} from "./subagent-orphan-attribution.js";
import { reconcileOrphanedRun } from "./subagent-registry-helpers.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";

const LOST_CONTEXT_ERROR = "subagent run lost active execution context";
const ORPHAN_COMPLETION_SOURCE = "sweeper-orphaned-by-gateway-death";

/**
 * Reconciles one stale active run. Returns whether the registry was mutated;
 * the caller stops processing this run either way.
 */
export async function reconcileStaleActiveSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  now: number;
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  storeCache: SubagentSessionStoreCache;
  completeSubagentRunWithRecovery: (
    completion: SubagentCompletionRequest,
    source: string,
  ) => Promise<void>;
}): Promise<boolean> {
  const { entry, now, runId } = params;
  const accountId = entry.requesterOrigin?.accountId;
  // The reap happens arbitrarily long after the death — it includes however
  // long the host stayed down. Correlate against boot history before writing
  // anything about this run: the reap clock is not evidence of its lifetime.
  const assistantMessageCount = countRecordedSubagentAssistantMessages(entry);
  const boots = loadGatewayBootSegmentsForAttribution(now);
  const currentBootId = boots
    .toReversed()
    .find(
      (boot) => boot.pid === process.pid && boot.completedAtMs === null && boot.outcome === null,
    )?.bootId;
  const attribution = resolveSubagentOrphanAttribution({
    runStartedAtMs: entry.execution.startedAt ?? entry.createdAt,
    lastActivityAtMs: resolveSubagentRunLastActivityMs(entry),
    assistantMessageCount,
    boots,
    currentBootId,
  });
  const attributedError = attribution ? formatSubagentOrphanErrorMessage(attribution) : undefined;

  const orphanReason = resolveSubagentRunOrphanReason({ entry });
  if (orphanReason) {
    // Pruning is silent, and a run that died having produced nothing is exactly
    // the case only the spawning session can act on. When the death is
    // attributable, complete it instead so the existing announce path carries
    // the cause back to the requester rather than dropping the row.
    if (attribution && attributedError && assistantMessageCount === 0) {
      await params.completeSubagentRunWithRecovery(
        {
          runId,
          endedAt: attribution.diedAtMs,
          outcome: { status: "error", error: attributedError },
          reason: SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId,
          triggerCleanup: true,
        },
        ORPHAN_COMPLETION_SOURCE,
      );
      return true;
    }
    return reconcileOrphanedRun({
      runId,
      entry,
      reason: orphanReason,
      source: "resume",
      runs: params.runs,
      resumedRuns: params.resumedRuns,
    });
  }

  const completion = resolveCompletionFromSessionEntry(
    loadSubagentSessionEntry({
      childSessionKey: entry.childSessionKey,
      storeCache: params.storeCache,
    }),
    now,
    {
      notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
      failedRunError: attributedError,
    },
  );
  if (completion) {
    await params.completeSubagentRunWithRecovery(
      {
        runId,
        startedAt: completion.startedAt,
        endedAt: completion.endedAt,
        outcome: completion.outcome,
        reason: completion.reason,
        sendFarewell: true,
        accountId,
        triggerCleanup: true,
      },
      "sweeper-session-completion",
    );
    return false;
  }

  await params.completeSubagentRunWithRecovery(
    {
      runId,
      // An attributed death ended when the run died, not when it was found.
      endedAt: attribution?.diedAtMs ?? now,
      outcome: { status: "error", error: attributedError ?? LOST_CONTEXT_ERROR },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId,
      triggerCleanup: true,
    },
    attribution ? ORPHAN_COMPLETION_SOURCE : "sweeper-lost-context",
  );
  return false;
}
