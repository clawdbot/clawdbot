import { executeJobCore } from "./timer-execution.js";
import { onTimer } from "./timer-scheduler.js";

export type { CronTriggerEvalOutcome } from "./timer-execution-timeout.js";
export type { IsolatedAgentSetupTimeoutSignal } from "./timer-execution-timeout.js";
export { runsDetachedFromMainSession } from "./timer-execution-timeout.js";
export { executeJobCoreWithTimeout } from "./timer-job-runner.js";
export { maybeNotifyIsolatedAgentSetupTimeout } from "./timer-scheduler.js";
export { applyJobResult } from "./timer-outcomes.js";
export { applyTriggerRunResult } from "./timer-outcomes.js";
export { applyScriptRunResult } from "./timer-outcomes.js";
export { applyTriggerNoFireResult } from "./timer-outcomes.js";
export { armTimer } from "./timer-scheduler.js";
export { runMissedJobs } from "./timer-catchup.js";
export { stopTimer } from "./timer-execution.js";

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cronTimerTestApi")] = {
    executeJobCore,
    onTimer,
  };
}
