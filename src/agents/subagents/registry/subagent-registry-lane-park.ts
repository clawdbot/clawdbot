/**
 * Parks a completion announce whose requester still holds its session lane, and
 * re-drives it the moment that lane frees.
 *
 * The durable half of this already existed: the row keeps its pending final
 * delivery payload, its attempt count, and its `nextAttemptAt`, and
 * `resumeSubagentRun` re-enters the announce cleanup flow. What was missing was
 * a readiness signal — every re-attempt was a blind timer, which a requester
 * busy for an hour simply outlives. The requester's lane release IS the turn
 * boundary, so it is the primary edge here; the timer stays as a backstop for
 * the cases the edge cannot cover (a listener lost to a gateway restart, a lane
 * released before the listener was armed, a lane held by something that never
 * completes).
 */
import { defaultRuntime } from "../../../runtime.js";
import {
  isSessionLaneBusy,
  subscribeSessionLaneRelease,
} from "../../embedded-agent-runner/session-lane-availability.js";
import { ensureDeliveryState } from "./subagent-delivery-state.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
} from "./subagent-registry-helpers.js";
import { scheduleResumeSubagentRun } from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentLifecycleAnnounceCleanupContext } from "./subagent-registry-lifecycle-context.js";
import { markPendingFinalDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/**
 * Backstop cadence for a parked announce.
 *
 * Deliberately coarse: the lane-release edge is what makes delivery prompt, so
 * this only has to guarantee the row is never lost. Each wake is a lane read
 * plus a re-park — no dispatch, no model call — and the hard announce expiry
 * still bounds the total number of them.
 */
export const REQUESTER_LANE_BUSY_BACKSTOP_MS = 60_000;

export const PARKED_FOR_REQUESTER_LANE_ERROR = "announce deferred: requester session lane busy";

function resolveAnnounceHardExpiryMs(entry: SubagentRunRecord): number {
  return entry.expectsCompletionMessage === true
    ? ANNOUNCE_COMPLETION_HARD_EXPIRY_MS
    : ANNOUNCE_EXPIRY_MS;
}

/** True when a parked announce has outlived the window it may be held in. */
export function hasParkedAnnounceOutlivedExpiry(entry: SubagentRunRecord, now: number): boolean {
  const endedAt = entry.execution.endedAt;
  if (typeof endedAt !== "number") {
    return false;
  }
  return now - endedAt > resolveAnnounceHardExpiryMs(entry);
}

/**
 * Parks the row and arms both the lane-release edge and the timer backstop.
 *
 * The park is durable before either wake source is armed, so a process that dies
 * in between still finds a pending row with a `nextAttemptAt` on restore.
 */
export function parkAnnounceForRequesterLane(
  context: SubagentLifecycleAnnounceCleanupContext,
  parkParams: { runId: string; entry: SubagentRunRecord; now: number },
): void {
  const params = context.options;
  const { runId, entry, now } = parkParams;
  const requesterSessionKey = entry.requesterSessionKey?.trim();

  // A park is not an attempt: no announce turn was started, so it must not
  // consume a retry rung or the ladder would expire a requester that is merely
  // busy. The hard expiry below is what bounds a park.
  markPendingFinalDelivery({
    entry,
    error: PARKED_FOR_REQUESTER_LANE_ERROR,
    countAttempt: false,
  });
  const delivery = ensureDeliveryState(entry);
  delivery.windowStartedAt ??= entry.execution.endedAt ?? now;
  delivery.deadlineAt ??= delivery.windowStartedAt + resolveAnnounceHardExpiryMs(entry);
  delivery.nextAttemptAt = now + REQUESTER_LANE_BUSY_BACKSTOP_MS;
  entry.cleanupHandled = false;
  params.resumedRuns.delete(runId);
  params.persist(runId);

  // Backstop first: if arming the edge throws, the row is already re-driven.
  scheduleResumeSubagentRun(context, runId, entry, REQUESTER_LANE_BUSY_BACKSTOP_MS);
  if (!requesterSessionKey) {
    return;
  }

  const parkedAt = now;
  const resume = () => {
    context.takeRequesterLaneReleaseWaiter(runId)?.();
    if (params.runs.get(runId) !== entry || entry.delivery?.status === "delivered") {
      return;
    }
    defaultRuntime.log(
      `Subagent announce resuming after requester lane release run=${runId} ` +
        `requester=${requesterSessionKey} parkedForMs=${Date.now() - parkedAt}`,
    );
    // The lane release IS the readiness signal the backstop timestamp was
    // standing in for, so it has to retire that timestamp before re-driving.
    // `resumeSubagentRun` treats `delivery.nextAttemptAt` as a hard not-before
    // gate for required completions: left set, the edge would only reschedule
    // the remaining backstop delay, which is exactly the wait this park exists
    // to remove. Cleared durably, because a process that dies between here and
    // the announce must not restore a row still gated on a deadline whose
    // reason has passed.
    const resumeDelivery = ensureDeliveryState(entry);
    if (resumeDelivery.nextAttemptAt !== undefined) {
      resumeDelivery.nextAttemptAt = undefined;
      params.persist(runId);
    }
    params.resumedRuns.delete(runId);
    params.resumeSubagentRun(runId);
  };
  context.setRequesterLaneReleaseWaiter(
    runId,
    subscribeSessionLaneRelease(requesterSessionKey, resume),
  );
  // The lane can free between the busy read that decided to park and the
  // subscription above. Re-read now that the listener is armed: whichever of
  // the two observes the free lane wins, and `resume` is idempotent because it
  // takes (and clears) the waiter before doing anything.
  if (!isSessionLaneBusy(requesterSessionKey)) {
    resume();
  }
}
