/**
 * Subagent registry cleanup decisions.
 *
 * Decides whether completed runs can be cleaned up, deferred for descendants, retried, or abandoned.
 */
import { getDeliveryAttemptCount } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";

export { settleSubagentRunFromSessionStore } from "./subagent-session-reconciliation.js";

type DeferredCleanupDecision =
  | {
      kind: "defer-descendants";
      delayMs: number;
    }
  | {
      kind: "give-up";
      reason: "expiry" | "permanent_failure";
      retryCount?: number;
    }
  | {
      kind: "retry";
      retryCount: number;
      resumeDelayMs?: number;
    };

/** Resolve the lifecycle ended reason used when cleaning up a subagent run. */
export function resolveCleanupCompletionReason(
  entry: SubagentRunRecord,
): SubagentLifecycleEndedReason {
  return entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
}

/**
 * True while this run is in the durable, non-terminal-cleanup `child-unconfirmed`
 * state: it was completed on a deadline alone and nothing was ever observed to
 * stop the child.
 *
 * The registry row is terminal so the parent gets woken, but the child may still
 * be running, so **no terminal effect may run against it**: not the
 * `sessions.delete` that removes its session and transcript, not its attachments
 * directory, not its browser sessions, not its MCP runtimes, not the internal
 * session-effects teardown, not the context-engine "this child ended" report,
 * not the exactly-once terminal plugin hooks, and not the detached task's
 * terminal state — `shouldApplyRunScopedStatusUpdate` rejects
 * `timed_out` -> `succeeded`, so a published `timed_out` is the one projection a
 * later observed success could never repair.
 *
 * Only authoritative stop evidence promotes the row out of this state, never a
 * clock, and never the mere absence of a record. Two owners produce that
 * evidence:
 *
 * - **push** — a later lifecycle callback settles the run; the published
 *   provisional timeout is explicitly not preserved against it
 *   (`shouldPreservePublishedExplicitRunTimeout`), and the promotion reopens
 *   cleanup so the withheld effects finally run.
 * - **pull** — the sweeper re-reads the child's own persisted session entry
 *   (`settleSubagentRunFromSessionStore`). A terminal status there promotes the
 *   row; a `running` status defers it again, and an *absent* entry defers it too,
 *   so retention never deletes a child that is still alive and
 *   `archiveAfterMinutes: 0` keeps its documented no-auto-archive meaning.
 */
export function shouldDeferTerminalCleanupForUnconfirmedChild(entry: SubagentRunRecord): boolean {
  // One derivation, shared with the read/display projections in
  // `subagent-session-metrics.ts`. Those projections cannot import this module
  // (they are read by the leaf liveness/list layer), and a second copy of the
  // predicate is how a reader ends up disagreeing with the writer about whether
  // a child is known to have stopped.
  return isSubagentChildStopUnconfirmed(entry);
}

/**
 * Drop collector state a `child-unconfirmed` row must not carry.
 *
 * Older persisted rows may already have frozen a collector result and armed
 * group retention before this disposition existed. Neither is valid without
 * observed stop evidence, and either one lets a member nominate its whole group
 * for destructive archival, so both are cleared before the sweeper reads them.
 */
export function clearUnconfirmedCollectorRetention(entry: SubagentRunRecord): boolean {
  if (entry.collect !== true || !shouldDeferTerminalCleanupForUnconfirmedChild(entry)) {
    return false;
  }
  let mutated = false;
  if (entry.collectorCompletion !== undefined) {
    delete entry.collectorCompletion;
    mutated = true;
  }
  if (entry.archiveAtMs !== undefined) {
    delete entry.archiveAtMs;
    mutated = true;
  }
  return mutated;
}

/**
 * Whether one group member forbids archiving its swarm group right now.
 *
 * The sweeper evaluates this twice — once to select a candidate group and again
 * under the post-cleanup revalidation — and the two must agree exactly, so they
 * ask here rather than each restating the condition.
 */
export function blocksSwarmGroupArchival(entry: SubagentRunRecord, now: number): boolean {
  return (
    !entry.collectorCompletion ||
    shouldDeferTerminalCleanupForUnconfirmedChild(entry) ||
    entry.collectorLaunchCleanupPending === true ||
    entry.archiveAtMs === undefined ||
    entry.archiveAtMs > now
  );
}

/**
 * Cleanup mode this attempt may actually act on. An unconfirmed child downgrades
 * a delete-mode run to keep for the duration of this cleanup attempt.
 */
export function resolveEffectiveCleanupMode(
  entry: SubagentRunRecord,
  cleanup?: "delete" | "keep",
): "delete" | "keep" {
  if (shouldDeferTerminalCleanupForUnconfirmedChild(entry)) {
    return "keep";
  }
  return cleanup ?? entry.cleanup;
}

/**
 * Whether this cleanup attempt may remove the run's attachments directory.
 *
 * The single owner of that decision: every cleanup path asks here rather than
 * re-deriving `cleanup === "delete" || !retainAttachmentsOnKeep`, and
 * `safeRemoveAttachmentsDir` re-checks the provisional predicate itself so a new
 * call site cannot reintroduce the bypass.
 */
export function shouldDeleteSubagentAttachments(
  entry: SubagentRunRecord,
  cleanup?: "delete" | "keep",
): boolean {
  if (shouldDeferTerminalCleanupForUnconfirmedChild(entry)) {
    // A live child may still be writing here; the directory is removed once an
    // observed stop promotes the row and the ordinary owner retires it.
    return false;
  }
  return (cleanup ?? entry.cleanup) === "delete" || !entry.retainAttachmentsOnKeep;
}

function resolveEndedAgoMs(entry: SubagentRunRecord, now: number): number {
  return typeof entry.execution.endedAt === "number" ? now - entry.execution.endedAt : 0;
}

/** Decide whether deferred subagent cleanup should retry, defer, or give up. */
export function resolveDeferredCleanupDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  activeDescendantRuns: number;
  announceExpiryMs: number;
  announceCompletionHardExpiryMs: number;
  deferDescendantDelayMs: number;
  resolveAnnounceRetryDelayMs: (retryCount: number) => number;
}): DeferredCleanupDecision {
  const endedAgo = resolveEndedAgoMs(params.entry, params.now);
  const isCompletionMessageFlow = params.entry.expectsCompletionMessage === true;
  const completionHardExpiryExceeded =
    isCompletionMessageFlow && endedAgo > params.announceCompletionHardExpiryMs;
  if (isCompletionMessageFlow && params.activeDescendantRuns > 0) {
    if (completionHardExpiryExceeded) {
      return { kind: "give-up", reason: "expiry" };
    }
    return { kind: "defer-descendants", delayMs: params.deferDescendantDelayMs };
  }

  const retryCount = getDeliveryAttemptCount(params.entry) + 1;
  const expiryExceeded = isCompletionMessageFlow
    ? completionHardExpiryExceeded
    : endedAgo > params.announceExpiryMs;
  if (params.entry.delivery?.disposition === "permanent_failure" || expiryExceeded) {
    return {
      kind: "give-up",
      reason:
        params.entry.delivery?.disposition === "permanent_failure" ? "permanent_failure" : "expiry",
      retryCount,
    };
  }

  const persistedNextAttemptAt = params.entry.delivery?.nextAttemptAt;
  const nextAttemptAt =
    typeof persistedNextAttemptAt === "number" && persistedNextAttemptAt > params.now
      ? persistedNextAttemptAt
      : params.now + params.resolveAnnounceRetryDelayMs(retryCount);

  return {
    kind: "retry",
    retryCount,
    resumeDelayMs: nextAttemptAt - params.now,
  };
}
