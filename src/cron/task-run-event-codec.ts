/** Write-side cron codec: converts a finished service event into a run-history entry.
 * Kept separate from task-run-detail.ts so the read/history codec stays free of the
 * agents failover tree (which transitively pulls the sandbox module graph). */
import { resolveCronRunErrorReason } from "./run-error-reason.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import type { CronEvent } from "./service/state.js";
import type { CronRunErrorClassification } from "./types.js";

type CronFinishedEvent = CronEvent & { action: "finished" };

/** Uses execution timing for one timestamp shared by ledger and legacy dual-write paths. */
function resolveCronRunEndedAt(event: CronFinishedEvent, fallbackTs: number): number {
  if (
    typeof event.runAtMs === "number" &&
    Number.isFinite(event.runAtMs) &&
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs)
  ) {
    return event.runAtMs + event.durationMs;
  }
  return fallbackTs;
}

/** Builds the legacy run-history record from one finished service event. */
export function cronRunLogEntryFromEvent(
  event: CronFinishedEvent,
  fallbackTs: number,
  errorClassification?: CronRunErrorClassification,
): CronRunLogEntry {
  const errorReason = resolveCronRunErrorReason(event.error, event.provider, errorClassification);
  return {
    ts: resolveCronRunEndedAt(event, fallbackTs),
    jobId: event.jobId,
    action: "finished",
    status: event.status,
    error: event.error,
    errorReason,
    summary: event.summary,
    diagnostics: event.diagnostics,
    delivered: event.delivered,
    deliveryStatus: event.deliveryStatus,
    deliveryError: event.deliveryError,
    failureNotificationDelivery: event.failureNotificationDelivery,
    delivery: event.delivery,
    sessionId: event.sessionId,
    sessionKey: event.sessionKey,
    runId: event.runId,
    runAtMs: event.runAtMs,
    durationMs: event.durationMs,
    nextRunAtMs: event.nextRunAtMs,
    triggerFired: event.triggerFired,
    model: event.model,
    provider: event.provider,
    usage: event.usage,
  };
}
