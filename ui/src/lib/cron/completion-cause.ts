/**
 * UI classification labels for the runs table and the jobs table failure column.
 *
 * Producer-authored `completionCause` wins over derived attribution. When no
 * cause is set, the label falls back to a derived state from the run entry
 * alone: a run-history row carries no job state, so job-level facts
 * (auto-disable, the job's latest run) must never be inferred here.
 */
import type { CronRunLogEntry } from "../../api/types.ts";

/** Distinct failure buckets the Automations pane surfaces. */
export type RunFailureLabel =
  | "active"
  | "previous"
  | "historical"
  | "gatewayRestart"
  | "ownerUnavailable"
  | "budgetExhausted";

/**
 * Window (ms) inside which a "previous" failure is still treated as the
 * current actionable failure. Past it, the failure becomes historical.
 */
const ACTIVE_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a run failed: the producer codec's completionStatus is authoritative
 * when present; legacy entries predate it and only carry the deprecated
 * status field.
 */
function isFailedRun(entry: Pick<CronRunLogEntry, "completionStatus" | "status">): boolean {
  if (entry.completionStatus === "failed") {
    return true;
  }
  if (entry.completionStatus === "succeeded") {
    return false;
  }
  return entry.status === "error";
}

/** Pick the producer-authoritative label, otherwise a derived state label. */
export function runFailureLabel(
  entry: Pick<CronRunLogEntry, "completionCause" | "completionStatus" | "status" | "ts">,
  nowMs: number,
): RunFailureLabel | null {
  if (entry.completionCause === "gateway-restart") {
    return "gatewayRestart";
  }
  if (entry.completionCause === "owner-unavailable") {
    return "ownerUnavailable";
  }
  if (entry.completionCause === "budget-exhausted") {
    return "budgetExhausted";
  }
  if (!isFailedRun(entry)) {
    return null;
  }
  // Recency is the run's own timestamp, never the job's last-run state: the
  // wire entry does not carry it.
  if (!Number.isFinite(entry.ts)) {
    return "historical";
  }
  return nowMs - entry.ts <= ACTIVE_FAILURE_WINDOW_MS ? "active" : "previous";
}
