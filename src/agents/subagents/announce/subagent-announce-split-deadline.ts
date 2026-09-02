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
 * (`agent-request-preflight.ts`). The in-process turn facade invokes
 * `onExecutionStarted` at the production lane-admission boundary, so that
 * callback switches this call from the admission budget to the run budget.
 */
export async function runWithAnnounceSplitDeadlines<T>(params: {
  runId: string;
  admissionTimeoutMs: number;
  runTimeoutMs: number;
  signal?: AbortSignal;
  run: (
    dispatchTimeoutMs: number,
    signal: AbortSignal,
    onExecutionStarted: () => void,
  ) => Promise<T>;
}): Promise<T> {
  let admitted = false;
  let admissionTimer: NodeJS.Timeout | undefined;
  let runTimer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const dispatchSignal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  const clearDeadlines = () => {
    if (admissionTimer) {
      clearTimeout(admissionTimer);
    }
    if (runTimer) {
      clearTimeout(runTimer);
    }
  };
  admissionTimer = setSafeTimeout(() => {
    // A start event landing in the same tick as the timer still counts.
    if (admitted) {
      return;
    }
    controller.abort(new AnnounceNotAdmittedError(params.runId, params.admissionTimeoutMs));
  }, params.admissionTimeoutMs);
  admissionTimer.unref?.();
  const onExecutionStarted = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    if (admissionTimer) {
      clearTimeout(admissionTimer);
      admissionTimer = undefined;
    }
    runTimer = setSafeTimeout(() => {
      controller.abort(new AnnounceRunBudgetExceededError(params.runId, params.runTimeoutMs));
    }, params.runTimeoutMs);
    runTimer.unref?.();
  };
  try {
    const dispatchTimeoutMs = addSafeTimeoutDelayGraceMs(
      addSafeTimeoutDelayGraceMs(params.admissionTimeoutMs, params.runTimeoutMs),
      ANNOUNCE_DISPATCH_RELEASE_GRACE_MS,
    );
    // The deadline aborts the dispatch rather than merely abandoning its
    // promise. The dispatch owns cancellation of its accepted/queued Gateway
    // run before it rejects, so callers can safely choose another delivery
    // path without a late duplicate.
    return await params.run(dispatchTimeoutMs, dispatchSignal, onExecutionStarted);
  } finally {
    clearDeadlines();
  }
}
