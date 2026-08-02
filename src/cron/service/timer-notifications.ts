import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import type { IsolatedAgentSetupTimeoutResult } from "./timer-execution-timeout.js";

function notifyIsolatedAgentSetupTimeout(
  state: CronServiceState,
  job: CronJob,
  error: string,
  timeoutMs: number,
  onAsyncFailure: () => void,
): boolean {
  const notify = state.deps.onIsolatedAgentSetupTimeout;
  if (!notify) {
    return false;
  }
  try {
    void Promise.resolve(notify({ job, error, timeoutMs })).catch((err: unknown) => {
      state.restartRecoveryPending = false;
      state.deps.log.warn(
        { jobId: job.id, err: String(err) },
        "cron: isolated setup timeout handler failed",
      );
      onAsyncFailure();
    });
    return true;
  } catch (err) {
    state.deps.log.warn(
      { jobId: job.id, err: String(err) },
      "cron: isolated setup timeout handler failed",
    );
    return false;
  }
}

export function maybeNotifyIsolatedAgentSetupTimeoutWithRecovery(
  state: CronServiceState,
  result: IsolatedAgentSetupTimeoutResult,
  onAsyncFailure: () => void,
): boolean {
  const signal = result.isolatedAgentSetupTimeout;
  if (!signal) {
    return false;
  }
  const notified = notifyIsolatedAgentSetupTimeout(
    state,
    result.job,
    signal.error,
    signal.timeoutMs,
    onAsyncFailure,
  );
  if (!notified) {
    return false;
  }
  return true;
}
