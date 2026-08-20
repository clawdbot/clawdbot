/**
 * Separate admission and run deadlines for the synchronous announce dispatch.
 *
 * The announce agent call waits for two unrelated things in sequence: the
 * requester session lane admitting a new turn, then that turn producing its
 * final. A single budget over both cannot tell them apart, so a lane-blocked
 * announce and an admitted-but-slow announce failed with the identical
 * `gateway request timeout for agent` error and the identical warn line. They
 * are bounded separately here and fail with distinct errors so callers, logs,
 * and triage can act on the difference.
 */
import { onAgentEvent } from "../../../infra/agent-events.js";
import { addSafeTimeoutDelayGraceMs, setSafeTimeout } from "../../../utils/timer-delay.js";

// The dispatch keeps an outer deadline of its own so an announce this call has
// already abandoned still settles and releases its delegated-tool handoff. It
// sits past the run budget on purpose: the budgets below must always fire first,
// otherwise the failure reverts to an unattributable `gateway request timeout`.
const ANNOUNCE_DISPATCH_RELEASE_GRACE_MS = 30_000;

/** The announce turn never started: its requester session lane stayed busy. */
export class AnnounceNotAdmittedError extends Error {
  constructor(runId: string, admissionTimeoutMs: number) {
    super(
      `announce not admitted (lane busy) run=${runId} admissionTimeoutMs=${admissionTimeoutMs}`,
    );
    this.name = "AnnounceNotAdmittedError";
  }
}

/** The announce turn started and then outran its own budget. */
export class AnnounceRunBudgetExceededError extends Error {
  constructor(runId: string, runTimeoutMs: number) {
    super(`announce run exceeded budget run=${runId} runTimeoutMs=${runTimeoutMs}`);
    this.name = "AnnounceRunBudgetExceededError";
  }
}

/**
 * Runs the announce dispatch under two deadlines instead of one.
 *
 * `runId` is the gateway run id of the announce turn — the same value the
 * dispatch passes as `idempotencyKey`, which the gateway adopts as its run id
 * (`agent-request-preflight.ts`). The lifecycle `start` event for that run id is
 * the only signal that the turn was admitted rather than queued behind the
 * requester's own turn, so it is what switches this call from the admission
 * budget to the run budget.
 */
export async function runWithAnnounceSplitDeadlines<T>(params: {
  runId: string;
  admissionTimeoutMs: number;
  runTimeoutMs: number;
  run: (dispatchTimeoutMs: number) => Promise<T>;
}): Promise<T> {
  let admitted = false;
  let admissionTimer: NodeJS.Timeout | undefined;
  let runTimer: NodeJS.Timeout | undefined;
  const clearDeadlines = () => {
    if (admissionTimer) {
      clearTimeout(admissionTimer);
    }
    if (runTimer) {
      clearTimeout(runTimer);
    }
  };
  const unsubscribe = onAgentEvent((evt) => {
    if (
      admitted ||
      evt.runId !== params.runId ||
      evt.stream !== "lifecycle" ||
      evt.data?.phase !== "start"
    ) {
      return;
    }
    admitted = true;
    if (admissionTimer) {
      clearTimeout(admissionTimer);
      admissionTimer = undefined;
    }
  });
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      admissionTimer = setSafeTimeout(() => {
        // A start event landing in the same tick as the timer still counts.
        if (admitted) {
          return;
        }
        reject(new AnnounceNotAdmittedError(params.runId, params.admissionTimeoutMs));
      }, params.admissionTimeoutMs);
      admissionTimer.unref?.();
      runTimer = setSafeTimeout(() => {
        reject(new AnnounceRunBudgetExceededError(params.runId, params.runTimeoutMs));
      }, params.runTimeoutMs);
      runTimer.unref?.();
    });
    const dispatchTimeoutMs = addSafeTimeoutDelayGraceMs(
      params.runTimeoutMs,
      ANNOUNCE_DISPATCH_RELEASE_GRACE_MS,
    );
    return await Promise.race([params.run(dispatchTimeoutMs), deadline]);
  } finally {
    unsubscribe();
    clearDeadlines();
  }
}
