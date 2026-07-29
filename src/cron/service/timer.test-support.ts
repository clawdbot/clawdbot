import type { CronDeliveryTrace, CronJob, CronRunOutcome, CronRunTelemetry } from "../types.js";
import type { CronServiceState } from "./state.js";
import type { CronTriggerEvalOutcome } from "./timer.js";
import "./timer.js";

type ExecuteJobCoreResult = CronRunOutcome &
  CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    deliveryError?: string;
    delivery?: CronDeliveryTrace;
    triggerEval?: CronTriggerEvalOutcome;
  };

type CronTimerTestApi = {
  executeJobCore(
    state: CronServiceState,
    job: CronJob,
    abortSignal?: AbortSignal,
  ): Promise<ExecuteJobCoreResult>;
  onTimer(state: CronServiceState): Promise<void>;
};

function getTestApi(): CronTimerTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cronTimerTestApi")
  ] as CronTimerTestApi;
}

export function executeJobCore(
  state: CronServiceState,
  job: CronJob,
  abortSignal?: AbortSignal,
): Promise<ExecuteJobCoreResult> {
  return getTestApi().executeJobCore(state, job, abortSignal);
}

export function onTimer(state: CronServiceState): Promise<void> {
  return getTestApi().onTimer(state);
}
