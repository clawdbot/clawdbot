/**
 * Durable agent-visible outcome for terminally failed continuation work.
 *
 * `enqueueSystemEvent` is an explicitly non-durable in-process queue, so it
 * cannot on its own satisfy the product invariant that every action ends in a
 * visible outcome: a gateway restart between the terminal write and the next
 * prompt drain would silently discard the notice, and terminal rows are invisible
 * to normal continuation recovery.
 *
 * The obligation therefore moves through three owners, each handoff either
 * CAS-guarded or idempotent, so no crash window can lose or duplicate it:
 *
 *   1. `work-store` persists `terminalNoticePending` in the SAME CAS that fails
 *      the row. A crash here leaves the obligation readable in the store.
 *   2. this module hands the notice to the durable session-delivery queue under
 *      a flow-stable idempotency key, then CAS-clears the flag. A crash between
 *      those two steps replays step 2, and the stable key collapses the retry
 *      onto the same durable row rather than enqueueing a second one.
 *   3. the delivery queue owns delivery from that point. The in-memory event is
 *      only the fast path; it carries the durable row's ack id, and that row is
 *      acknowledged only after the prompt actually consumes it, so a restart
 *      before consumption replays the notice instead of dropping it.
 *
 * This mirrors the durable-return path in `targeting.ts`, which uses the same
 * queue, ack-id, and idempotency-key primitives.
 */

import {
  markTrustedContinuationHeartbeatWake,
  requestHeartbeatNow,
} from "../../infra/heartbeat-wake.js";
import { scheduleSessionDelivery } from "../../infra/session-delivery-queue-runtime.js";
import { enqueueSessionDeliveryWithStatus } from "../../infra/session-delivery-queue-storage.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PendingContinuationWork } from "./work-flow-state.js";
import {
  clearPendingTerminalNotice,
  listPendingTerminalNoticeWork,
  readPendingTerminalNoticeWork,
} from "./work-store.js";

const log = createSubsystemLogger("continuation/work-terminal-notice");

/**
 * Operator-facing detail (provider payloads, URLs, credentials) never reaches
 * this string: it is injected into the model's context. The raw driver error
 * stays on the durable row's blocked summary and in the terminal error log.
 */
export const CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE =
  "[system:continuation-warning] continue_work permanently failed after exhausting its retries; the scheduled follow-up turn will not run. Reissue continue_work if the work is still needed.";

/** Flow-stable so a replayed handoff reuses one durable row instead of adding another. */
function continuationWorkTerminalNoticeIdempotencyKey(flowId: string): string {
  return `continuation-work-terminal-notice:${flowId}`;
}

type ContinuationWorkTerminalNoticeDeps = {
  enqueueSessionDeliveryWithStatus: typeof enqueueSessionDeliveryWithStatus;
  scheduleSessionDelivery: typeof scheduleSessionDelivery;
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestHeartbeatNow: typeof requestHeartbeatNow;
  stateDir?: string;
};

const defaultDeps: ContinuationWorkTerminalNoticeDeps = {
  enqueueSessionDeliveryWithStatus,
  scheduleSessionDelivery,
  enqueueSystemEvent,
  requestHeartbeatNow,
};

/**
 * Hand one pending terminal notice to the durable queue and release the flag.
 *
 * Enqueue precedes the clear on purpose: losing the clear only replays an
 * idempotent enqueue, whereas clearing first would reopen the crash window the
 * durable flag exists to close.
 */
export async function deliverPendingTerminalNotice(
  work: PendingContinuationWork,
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<boolean> {
  if (!work.flowId) {
    return false;
  }
  // Re-read under a current revision: the caller that terminalized the row holds
  // the pre-CAS revision, and another drain may already have taken ownership.
  const pending = readPendingTerminalNoticeWork(work.flowId);
  if (!pending) {
    return false;
  }
  const enqueued = await deps.enqueueSessionDeliveryWithStatus(
    {
      kind: "systemEvent",
      sessionKey: pending.sessionKey,
      text: CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE,
      idempotencyKey: continuationWorkTerminalNoticeIdempotencyKey(work.flowId),
      // The row must outlive the in-memory event and survive until the prompt
      // adopts it; see the delivery path's plain-event deferral.
      awaitPromptAdoption: true,
    },
    deps.stateDir,
  );
  if (enqueued.status === "unknown") {
    // The authoritative read was inconclusive, so this row may already be a
    // completed tombstone. Surfacing now could duplicate a settled outcome, and
    // clearing the flag would discard the only restart backstop. Treat it as a
    // failed handoff: keep the obligation and let the bounded retry re-resolve.
    throw new Error(`continuation terminal notice enqueue status unresolved for ${enqueued.id}`);
  }
  if (enqueued.status === "completed") {
    // A tombstone already settled this key: the outcome was delivered and
    // adopted on an earlier pass, and the durable enqueue above was a no-op.
    // Releasing the stale flag is the whole job — emitting another in-memory
    // event or wake here would surface a second copy of a settled outcome.
    if (clearPendingTerminalNotice(pending)) {
      log.info(
        `[continuation:work-terminal-notice-already-settled] flowId=${work.flowId} session=${pending.sessionKey} deliveryId=${enqueued.id}`,
      );
    }
    return false;
  }
  if (!clearPendingTerminalNotice(pending)) {
    // Another drain won the clear. The deterministic idempotency key means it
    // owns THIS row, not a duplicate — acknowledging here would complete the
    // winner's only durable record before the prompt ever consumed it. Leave it
    // alone; a completed tombstone already makes re-enqueue a no-op.
    return false;
  }
  deps.enqueueSystemEvent(CONTINUATION_WORK_RETRY_EXHAUSTED_NOTICE, {
    sessionKey: pending.sessionKey,
    trusted: true,
    sessionDeliveryAckId: enqueued.id,
    // Prompt preparation is not adoption. Settle only once the prepared turn is
    // durably adopted, so an admission failure or crash replays the notice.
    sessionDeliveryAwaitsTurnAdoption: true,
    ...(deps.stateDir ? { sessionDeliveryAckStateDir: deps.stateDir } : {}),
  });
  // Startup scans the delivery queue before continuation recovery runs, so a
  // row created here would otherwise carry no timer and wait for unrelated
  // traffic. Arm it explicitly and wake the target.
  await deps.scheduleSessionDelivery(enqueued.id);
  deps.requestHeartbeatNow(
    markTrustedContinuationHeartbeatWake({
      sessionKey: pending.sessionKey,
      source: "other" as const,
      intent: "immediate" as const,
      reason: "continuation-terminal-notice",
    }),
  );
  log.info(
    `[continuation:work-terminal-notice-handed-off] flowId=${work.flowId} session=${pending.sessionKey} deliveryId=${enqueued.id}`,
  );
  return true;
}

/** Hard bound on live retries of a failed durable handoff. */
export const TERMINAL_NOTICE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Test-only: cancel armed retry timers. */
export function resetTerminalNoticeRetriesForTests(): void {
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
}

/**
 * Arm a bounded live retry for a handoff that failed before reaching the queue.
 *
 * A flag-only obligation is invisible to the delivery scheduler (it has no row
 * yet), so without this it would wait for the next gateway restart. Retries are
 * hard-capped; the durable flag is never cleared by a failure, so a restart
 * remains the final backstop.
 */
function armTerminalNoticeRetry(
  work: PendingContinuationWork,
  attempt: number,
  deps: ContinuationWorkTerminalNoticeDeps,
): void {
  const flowId = work.flowId;
  const delayMs = TERMINAL_NOTICE_RETRY_DELAYS_MS[attempt];
  if (!flowId || delayMs === undefined || retryTimers.has(flowId)) {
    return;
  }
  const timer = setTimeout(() => {
    retryTimers.delete(flowId);
    void (async () => {
      const owed = readPendingTerminalNoticeWork(flowId);
      if (!owed) {
        return;
      }
      try {
        await deliverPendingTerminalNotice(owed, deps);
      } catch (err) {
        log.error(
          `[continuation:work-terminal-notice-retry-error] flowId=${flowId} attempt=${attempt + 1}/${TERMINAL_NOTICE_RETRY_DELAYS_MS.length} error=${err instanceof Error ? err.message : String(err)}`,
        );
        armTerminalNoticeRetry(owed, attempt + 1, deps);
      }
    })();
  }, delayMs);
  timer.unref?.();
  retryTimers.set(flowId, timer);
}

/**
 * Hand off one notice, arming a bounded live retry if the durable enqueue fails.
 *
 * The flag survives every failure, so the obligation is never lost; the retry
 * only removes the dependency on an unrelated restart.
 */
export async function deliverPendingTerminalNoticeWithRetry(
  work: PendingContinuationWork,
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<boolean> {
  try {
    return await deliverPendingTerminalNotice(work, deps);
  } catch (err) {
    log.error(
      `[continuation:work-terminal-notice-error] flowId=${work.flowId ?? "none"} session=${work.sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
    );
    armTerminalNoticeRetry(work, 0, deps);
    return false;
  }
}

/**
 * Replay every notice the store still owes. Safe to call on every startup: rows
 * whose notice already reached the delivery queue no longer carry the flag.
 */
export async function drainPendingTerminalNotices(
  deps: ContinuationWorkTerminalNoticeDeps = defaultDeps,
): Promise<number> {
  let delivered = 0;
  for (const work of listPendingTerminalNoticeWork()) {
    try {
      if (await deliverPendingTerminalNoticeWithRetry(work, deps)) {
        delivered += 1;
      }
    } catch (err) {
      // Leave the flag set so the next drain retries; never drop the obligation.
      log.error(
        `[continuation:work-terminal-notice-drain-error] flowId=${work.flowId ?? "none"} session=${work.sessionKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return delivered;
}
