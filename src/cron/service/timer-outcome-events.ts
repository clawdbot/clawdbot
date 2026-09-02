import type { CronJob } from "../types.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { cronFailureNotificationEventContext, emit, type CronServiceState } from "./state.js";
import { tryFinishCronTaskRun } from "./task-runs.js";
import type { TimedCronRunOutcome } from "./timer-execution-timeout.js";

function cronOutcomeEvent(job: CronJob, result: TimedCronRunOutcome, runAtMs: number) {
  return {
    jobId: job.id,
    action: "finished",
    job,
    status: result.status,
    completionStatus: result.completionStatus,
    error: result.error,
    summary: result.summary,
    diagnostics: result.diagnostics,
    delivered: job.state.lastDelivered,
    deliveryStatus: job.state.lastDeliveryStatus,
    deliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    failureNotificationDelivery: failureNotificationDeliveryFromJobState(job),
    delivery: result.delivery,
    sessionId: result.sessionId,
    sessionKey: result.sessionKey,
    runAtMs,
    durationMs: job.state.lastDurationMs,
    nextRunAtMs: job.state.nextRunAtMs,
    ...(result.triggerEval?.fired ? { triggerFired: true } : {}),
    model: result.model,
    provider: result.provider,
    usage: result.usage,
  } as const;
}

export function recordCronOutcomeForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): void {
  const event = cronOutcomeEvent(job, result, result.startedAt);
  tryFinishCronTaskRun(state, {
    taskRunId: result.taskRunId,
    job,
    event,
    errorClassification: result.errorClassification,
    scriptResult: {
      scriptStateChanged: result.scriptStateChanged,
      scriptState: result.scriptState,
    },
    ...(result.triggerEval ? { triggerEval: result.triggerEval } : {}),
  });
}

export function emitCronOutcomeEventForJob(
  state: CronServiceState,
  job: CronJob,
  result: TimedCronRunOutcome,
): void {
  emit(
    state,
    cronOutcomeEvent(job, result, result.startedAt),
    cronFailureNotificationEventContext(result.failureNotificationDetail),
  );
}
