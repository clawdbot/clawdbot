/** Pure aggregation of cron run-history into cost/efficiency stats (#112371 Wave 3). */
import type { CronRunLogEntry } from "./run-log-types.js";

/** Per-status counts and token totals across a set of cron runs. */
export type CronRunCostRollup = {
  totalRuns: number;
  ok: number;
  error: number;
  skipped: number;
  /** Skipped runs whose reason/summary indicates a precheck no-work gate. */
  precheckSkipped: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Runs that recorded any token usage (i.e. actually called a model). */
  modelRuns: number;
  /** Fraction of runs that skipped (0..1); 0 when there are no runs. */
  skipRate: number;
};

const PRECHECK_SKIP_MARKERS = ["precheck-no-work", "precheck-timeout", "precheck-error"];

function isPrecheckSkip(entry: CronRunLogEntry): boolean {
  const haystack = `${entry.error ?? ""} ${entry.summary ?? ""}`.toLowerCase();
  return PRECHECK_SKIP_MARKERS.some((marker) => haystack.includes(marker));
}

/** Roll a list of run-log entries into aggregate cost stats. Pure + deterministic. */
export function rollupCronRunCost(entries: readonly CronRunLogEntry[]): CronRunCostRollup {
  const rollup: CronRunCostRollup = {
    totalRuns: 0,
    ok: 0,
    error: 0,
    skipped: 0,
    precheckSkipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelRuns: 0,
    skipRate: 0,
  };

  for (const entry of entries) {
    if (!entry || entry.action !== "finished") {
      continue;
    }
    rollup.totalRuns += 1;
    switch (entry.status) {
      case "ok":
        rollup.ok += 1;
        break;
      case "error":
        rollup.error += 1;
        break;
      case "skipped":
        rollup.skipped += 1;
        if (isPrecheckSkip(entry)) {
          rollup.precheckSkipped += 1;
        }
        break;
      default:
        break;
    }
    const input = entry.usage?.input_tokens ?? 0;
    const output = entry.usage?.output_tokens ?? 0;
    const total = entry.usage?.total_tokens ?? input + output;
    if (total > 0 || input > 0 || output > 0) {
      rollup.modelRuns += 1;
    }
    rollup.inputTokens += input;
    rollup.outputTokens += output;
    rollup.totalTokens += total;
  }

  rollup.skipRate = rollup.totalRuns > 0 ? rollup.skipped / rollup.totalRuns : 0;
  return rollup;
}

/** Merge many per-job rollups into a fleet-wide rollup. */
export function mergeCronRunCostRollups(rollups: readonly CronRunCostRollup[]): CronRunCostRollup {
  const merged: CronRunCostRollup = {
    totalRuns: 0,
    ok: 0,
    error: 0,
    skipped: 0,
    precheckSkipped: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelRuns: 0,
    skipRate: 0,
  };
  for (const r of rollups) {
    merged.totalRuns += r.totalRuns;
    merged.ok += r.ok;
    merged.error += r.error;
    merged.skipped += r.skipped;
    merged.precheckSkipped += r.precheckSkipped;
    merged.inputTokens += r.inputTokens;
    merged.outputTokens += r.outputTokens;
    merged.totalTokens += r.totalTokens;
    merged.modelRuns += r.modelRuns;
  }
  merged.skipRate = merged.totalRuns > 0 ? merged.skipped / merged.totalRuns : 0;
  return merged;
}

/** Render a compact human-readable summary line for a rollup. */
export function formatCronRunCostRollup(rollup: CronRunCostRollup): string {
  const pct = (rollup.skipRate * 100).toFixed(1);
  return [
    `runs=${rollup.totalRuns}`,
    `ok=${rollup.ok}`,
    `error=${rollup.error}`,
    `skipped=${rollup.skipped} (${pct}%)`,
    `precheckSkipped=${rollup.precheckSkipped}`,
    `modelRuns=${rollup.modelRuns}`,
    `tokens=${rollup.totalTokens}`,
  ].join(" · ");
}
