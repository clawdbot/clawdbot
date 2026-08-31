import type { CronServiceState } from "./state.js";
import type { IsolatedAgentSetupTimeoutResult } from "./timer-execution-timeout.js";

export function maybeNotifyIsolatedAgentSetupTimeout(
  state: CronServiceState,
  result: IsolatedAgentSetupTimeoutResult,
): boolean {
  const signal = result.isolatedAgentSetupTimeout;
  if (!signal) {
    return false;
  }
  const notify = state.deps.onIsolatedAgentSetupTimeout;
  if (!notify) {
    return false;
  }
  const logFailure = (err: unknown) => {
    state.deps.log.warn(
      { jobId: result.job.id, err: String(err) },
      "cron: isolated setup timeout handler failed",
    );
  };
  try {
    void Promise.resolve(
      notify({ job: result.job, error: signal.error, timeoutMs: signal.timeoutMs }),
    ).catch(logFailure);
    return true;
  } catch (err) {
    logFailure(err);
    return false;
  }
}
