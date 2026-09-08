import { resolveCronJobConfigRevision } from "./config-revision.js";
import { toPublicCronJob } from "./public-job.js";
import type { CronJob } from "./types.js";

export function cronJobReadView(job: CronJob) {
  const publicJob = toPublicCronJob(job);
  return {
    ...publicJob,
    configRevision: resolveCronJobConfigRevision(job),
    nextRunAtMs: job.state.nextRunAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus,
    lastRunError: job.state.lastError,
    lastDelivered: job.state.lastDelivered,
    lastDeliveryStatus: job.state.lastDeliveryStatus,
    lastDeliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
  };
}

// Strip only metadata added by the public read view, never unknown definition fields.
// Stored revisions and privacy projection have separate owners and stay unchanged.
export function cronJobDefinitionFromReadView(view: Partial<ReturnType<typeof cronJobReadView>>) {
  const {
    configRevision: _configRevision,
    nextRunAtMs: _nextRunAtMs,
    lastRunAtMs: _lastRunAtMs,
    lastRunStatus: _lastRunStatus,
    lastRunError: _lastRunError,
    lastDelivered: _lastDelivered,
    lastDeliveryStatus: _lastDeliveryStatus,
    lastDeliveryError: _lastDeliveryError,
    deliverySuppressionReason: _deliverySuppressionReason,
    lastFailureNotificationDelivered: _lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: _lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: _lastFailureNotificationDeliveryError,
    ...definition
  } = view;
  return definition;
}
