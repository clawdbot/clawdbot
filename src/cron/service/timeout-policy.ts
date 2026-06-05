/** Resolves cron job wall-clock timeout policy. */
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import type { CronJob } from "../types.js";

/**
 * Maximum wall-clock time for a single job execution. Acts as a safety net
 * on top of per-provider/per-agent timeouts to prevent one stuck job from
 * wedging the entire cron lane.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Agent turns can legitimately run much longer than generic cron jobs.
 * Use a larger safety ceiling when no explicit timeout is set.
 */
export const AGENT_TURN_SAFETY_TIMEOUT_MS = 60 * 60_000; // 60 minutes

/** Resolves the wall-clock timeout for a cron job, including explicit agent-turn overrides. */
export function resolveCronJobTimeoutMs(job: CronJob): number | undefined {
  const configuredTimeoutMs =
    job.payload.kind === "agentTurn" && typeof job.payload.timeoutSeconds === "number"
      ? (finiteSecondsToTimerSafeMilliseconds(job.payload.timeoutSeconds) ?? 0)
      : undefined;
  if (configuredTimeoutMs === undefined) {
    return job.payload.kind === "agentTurn" ? AGENT_TURN_SAFETY_TIMEOUT_MS : DEFAULT_JOB_TIMEOUT_MS;
  }
  return configuredTimeoutMs <= 0 ? undefined : configuredTimeoutMs;
}
