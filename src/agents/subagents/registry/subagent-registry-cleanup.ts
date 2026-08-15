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
