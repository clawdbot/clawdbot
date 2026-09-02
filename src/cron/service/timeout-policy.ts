/** Resolves cron job wall-clock timeout policy. */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 */
const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000; // 60 minutes

export type ResolveCronJobTimeoutContext = {
  /**
   * Effective heartbeat timeout in milliseconds, resolved from agent config.
   * Used for heartbeat and main-session system-event payloads that hand off to
   * the heartbeat runner, so their outer cron watchdog honors the configured
   * heartbeat timeout instead of the generic 600s default.
   */
  resolvedHeartbeatTimeoutMs?: number;
};

/** Resolves the wall-clock timeout for a cron job, including explicit detached-run overrides. */
export function resolveCronJobTimeoutMs(
  job: CronJob,
  context?: ResolveCronJobTimeoutContext,
): number | undefined {
  const configuredTimeoutMs =
    (job.payload.kind === "agentTurn" ||
      job.payload.kind === "command" ||
      job.payload.kind === "script") &&
    typeof job.payload.timeoutSeconds === "number"
      ? (finiteSecondsToTimerSafeMilliseconds(job.payload.timeoutSeconds) ?? 0)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    if (
      (job.payload.kind === "heartbeat" || job.payload.kind === "systemEvent") &&
      typeof context?.resolvedHeartbeatTimeoutMs === "number"
    ) {
      return context.resolvedHeartbeatTimeoutMs <= 0
        ? undefined
        : context.resolvedHeartbeatTimeoutMs;
    }
    return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
