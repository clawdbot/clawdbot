import {
  CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
  tryResolveCronJobEffectiveAgentId,
} from "../agent-id.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { findActiveCronRunReceiptInDatabase } from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { hasActiveCronRun } from "./jobs-scheduling.js";
import { applyCronRuntimeRowsToState, commitCronRuntimeRows } from "./runtime-store.js";
import { emit, type CronServiceState, type DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult } from "./timer-outcomes.js";

/** Records ownerless scheduled attempts before one invalid job can block batch admission. */
export function skipCronJobsWithoutOwners(
  state: CronServiceState,
  candidates: CronJob[],
  nowMs: number,
): CronJob[] {
  const resolveOwnerAgentId = (job: CronJob) =>
    tryResolveCronJobEffectiveAgentId(
      job,
      state.deps.resolveDefaultAgentId
        ? state.deps.resolveDefaultAgentId()
        : state.deps.defaultAgentId,
    );
  const unresolved = new Map(
    candidates.filter((job) => !resolveOwnerAgentId(job)).map((job) => [job.id, job]),
  );
  if (unresolved.size === 0) {
    return candidates;
  }
  const notifications: DeferredCronNotifications = [];
  const skipped = commitCronRuntimeRows({
    state,
    jobIds: unresolved.keys(),
    operationLabel: "cron.unresolved-owner",
    mutate: ({ database, jobs }) => {
      const committed: CronJob[] = [];
      for (const [jobId, job] of jobs) {
        const planned = unresolved.get(jobId);
        if (
          !planned ||
          job.enabled !== planned.enabled ||
          job.state.nextRunAtMs !== planned.state.nextRunAtMs ||
          job.state.lastRunAtMs !== planned.state.lastRunAtMs ||
          job.state.lastRunStatus !== planned.state.lastRunStatus ||
          resolveCronJobConfigRevision(job) !== resolveCronJobConfigRevision(planned) ||
          hasActiveCronRun(job) ||
          findActiveCronRunReceiptInDatabase({
            database,
            storePath: state.deps.storePath,
            jobId,
          }) ||
          resolveOwnerAgentId(job)
        ) {
          continue;
        }
        applyJobResult(
          state,
          job,
          {
            status: "skipped",
            completionStatus: "failed",
            error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
            executionStarted: false,
            startedAt: nowMs,
            endedAt: nowMs,
          },
          { deferredNotifications: notifications },
        );
        committed.push(job);
      }
      return { upsertJobIds: committed.map((job) => job.id), value: committed };
    },
  });
  applyCronRuntimeRowsToState(state, skipped);
  for (const job of skipped) {
    state.deps.log.warn(
      { jobId: job.id, error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE },
      "cron: skipping job with unresolved owner",
    );
    // No agent was admitted, so preserve the failure without inventing a task or run receipt.
    emit(state, {
      jobId: job.id,
      action: "finished",
      job,
      status: "skipped",
      completionStatus: "failed",
      error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      runAtMs: nowMs,
      durationMs: 0,
      nextRunAtMs: job.state.nextRunAtMs,
      deliveryStatus: job.state.lastDeliveryStatus,
      deliveryError: job.state.lastDeliveryError,
    });
  }
  runPostPersistCronNotifications(state, notifications);
  return candidates.filter((job) => !unresolved.has(job.id));
}
