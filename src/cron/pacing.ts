import { parseDurationMs } from "../cli/parse-duration.js";
import type { CronPacing } from "./types.js";

/** Parsed positive pacing bounds used for validation and next-run clamping. */
type CronPacingBounds = {
  minMs?: number;
  maxMs?: number;
};

function parsePositivePacingDuration(value: string, field: "min" | "max"): number {
  let durationMs: number;
  try {
    durationMs = parseDurationMs(value);
  } catch {
    throw new Error(`cron pacing ${field} must be a positive duration`);
  }
  if (durationMs <= 0) {
    throw new Error(`cron pacing ${field} must be a positive duration`);
  }
  return durationMs;
}

/** Validates pacing strings and returns their millisecond bounds. */
export function parseCronPacingBounds(pacing: CronPacing): CronPacingBounds {
  if (pacing.min === undefined && pacing.max === undefined) {
    throw new Error("cron pacing requires at least one of min or max");
  }
  const minMs =
    pacing.min === undefined ? undefined : parsePositivePacingDuration(pacing.min, "min");
  const maxMs =
    pacing.max === undefined ? undefined : parsePositivePacingDuration(pacing.max, "max");
  if (minMs !== undefined && maxMs !== undefined && minMs > maxMs) {
    throw new Error("cron pacing min must not exceed max");
  }
  return { minMs, maxMs };
}

/** Clamps one successful run's proposal against its job-local pacing bounds. */
export function resolvePacedNextRunAtMs(params: {
  nowMs: number;
  delayMs: number;
  pacing: CronPacing;
}): number {
  const { minMs, maxMs } = parseCronPacingBounds(params.pacing);
  const proposedAtMs = params.nowMs + params.delayMs;
  return Math.min(
    params.nowMs + (maxMs ?? Number.POSITIVE_INFINITY),
    Math.max(params.nowMs + (minMs ?? 0), proposedAtMs),
  );
}
