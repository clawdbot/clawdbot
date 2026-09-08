export const SKIPPED_UPDATE_OUTCOMES: Readonly<Record<string, "pending" | "noop">> = {
  "managed-service-handoff-started": "pending",
  "restart-health-pending": "pending",
  "already-current": "noop",
  "managed-service-handoff-already-running": "noop",
  "managed-service-handoff-cancelled": "noop",
};

/** A skipped update can be a handoff, an intentional no-op, or a failed attempt. */
export function classifyUpdateOutcome(outcome: {
  status?: string;
  reason?: string;
}): "succeeded" | "pending" | "noop" | "failed" | undefined {
  if (outcome.status === "ok") {
    return "succeeded";
  }
  if (outcome.status === "error") {
    return "failed";
  }
  if (outcome.status !== "skipped") {
    return undefined;
  }
  return outcome.reason !== undefined && Object.hasOwn(SKIPPED_UPDATE_OUTCOMES, outcome.reason)
    ? SKIPPED_UPDATE_OUTCOMES[outcome.reason]
    : "failed";
}

/** Ledger refusals can be failed attempts even when no update work started. */
export function isReportableUpdateRun(run: { status: string; reason: string | null }): boolean {
  if (run.status === "failed" || run.status === "rolled-back") {
    return true;
  }
  // These are intentional CLI ledger outcomes, not failed update attempts.
  // Reuse the result owner's classification for all other skipped outcomes.
  return (
    run.status === "skipped" &&
    run.reason !== null &&
    run.reason !== "dry-run" &&
    run.reason !== "cancelled" &&
    classifyUpdateOutcome({ status: run.status, reason: run.reason }) === "failed"
  );
}
