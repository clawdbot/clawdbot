import { resolveCronJobConfigRevision } from "../config-revision.js";
import type { DetachedMediaCronFailureRecordRequest } from "../detached-media-failure-recorder.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import {
  canRecordDetachedFailureForCronRunReceiptInDatabase,
  findActiveCronRunReceiptInDatabase,
  recordDetachedFailureForCronRunReceiptInDatabase,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import { failureNotificationDeliveryFromJobState } from "./failure-alerts.js";
import { locked } from "./locked.js";
import { emitCronRunFinished } from "./ops-run-preparation.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import type { CronEvent, CronServiceState, DeferredCronNotifications } from "./state.js";
import { ensureLoaded, runPostPersistCronNotifications } from "./store.js";
import { applyJobResult, armTimer } from "./timer.js";

/** Records a detached failure only while its exact scheduler receipt still owns the job result. */
export async function recordDetachedMediaFailure(
  state: CronServiceState,
  request: DetachedMediaCronFailureRecordRequest,
): Promise<boolean> {
  return await locked(state, async () => {
    await ensureLoaded(state, { skipRecompute: true });
    const receipt = request.cronRunReceipt;
    const endedAt = state.deps.nowMs();
    const diagnostics = createCronRunDiagnosticsFromError("tool", request.error, {
      nowMs: state.deps.nowMs,
      toolName: request.toolName,
    });
    const postPersistNotifications: DeferredCronNotifications = [];
    const committed = commitCronRuntimeRows({
      state,
      jobIds: [receipt.jobId],
      operationLabel: "cron.detached-media-failure",
      transactionHooks: {
        afterWrite: (database) => {
          recordDetachedFailureForCronRunReceiptInDatabase({
            database,
            handle: receipt,
            finishedAtMs: endedAt,
            error: request.error,
          });
        },
        afterCommit: () => releaseLocalCronRunReceiptOwnership(receipt),
      },
      mutate: ({ database, jobs }) => {
        const job = jobs.get(receipt.jobId);
        const activeReceipt = findActiveCronRunReceiptInDatabase({
          database,
          storePath: state.deps.storePath,
          jobId: receipt.jobId,
        });
        const activeThisRun =
          job?.state.runningAtMs === receipt.startedAtMs &&
          activeReceipt?.receiptId === receipt.receiptId;
        const completedThisRun = job?.state.lastRunAtMs === receipt.startedAtMs;
        const anotherRunActive = job?.state.runningAtMs != null && !activeThisRun;
        if (
          !job ||
          resolveCronJobConfigRevision(job) !== receipt.configRevision ||
          anotherRunActive ||
          (!activeThisRun && !completedThisRun) ||
          (!activeThisRun && completedThisRun && job.state.lastRunStatus === "error") ||
          !canRecordDetachedFailureForCronRunReceiptInDatabase({ database, handle: receipt })
        ) {
          return { runHooks: false, value: undefined };
        }
        applyJobResult(
          state,
          job,
          {
            status: "error",
            error: request.error,
            diagnostics,
            executionStarted: true,
            sessionKey: request.requesterSessionKey,
            startedAt: receipt.startedAtMs,
            endedAt,
          },
          { scheduleMode: "preserve", deferredNotifications: postPersistNotifications },
        );
        const committedJob = structuredClone(job);
        const event: CronEvent & { action: "finished" } = {
          jobId: committedJob.id,
          action: "finished",
          job: committedJob,
          status: "error",
          error: request.error,
          diagnostics,
          runId: request.cronTaskRunId ?? request.runId,
          sessionKey: request.requesterSessionKey,
          runAtMs: receipt.startedAtMs,
          durationMs: committedJob.state.lastDurationMs,
          nextRunAtMs: committedJob.state.nextRunAtMs,
          deliveryStatus: committedJob.state.lastDeliveryStatus,
          failureNotificationDelivery: failureNotificationDeliveryFromJobState(committedJob),
        };
        return { upsertJobIds: [job.id], value: { event, job: committedJob } };
      },
    });
    if (!committed) {
      return false;
    }
    applyCronRuntimeRowsToState(state, [committed.job]);
    emitCronRunFinished(state, committed.event);
    runPostPersistCronNotifications(state, postPersistNotifications);
    armTimer(state);
    return true;
  });
}
