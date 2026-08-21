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
 * True when this run was completed on a deadline alone and nothing was ever
 * observed to stop the child (`child-unconfirmed`). The row is terminal so the
 * parent gets woken, but the child may still be running, so terminal cleanup
 * must not yet submit the `sessions.delete` that removes its session and
 * transcript, nor remove the attachments directory it may still be writing to.
 *
 * Deferral, not cancellation: `entry.cleanup` is left untouched, so the archive
 * deadline still arms for delete-mode runs and the sweeper deletes the session
 * once the retention window expires. Any real stop observed before then — by a
 * later `agent.wait`, a lifecycle event, or session reconciliation — settles the
 * row through the ordinary path.
 */
export function shouldDeferTerminalCleanupForUnconfirmedChild(entry: SubagentRunRecord): boolean {
  const outcome = entry.execution.outcome;
  return outcome?.status === "timeout" && outcome.timeoutDisposition === "child-unconfirmed";
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

/** Whether this cleanup attempt may remove the run's attachments directory. */
export function shouldDeleteSubagentAttachments(
  entry: SubagentRunRecord,
  cleanup?: "delete" | "keep",
): boolean {
  if (shouldDeferTerminalCleanupForUnconfirmedChild(entry)) {
    // A live child may still be writing here; the sweeper removes the directory
    // when it retires the row.
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
