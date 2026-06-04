/** Return true for the normalized liveness state that means a run is blocked. */
export function isBlockedLivenessState(livenessState: unknown): boolean {
  return typeof livenessState === "string" && livenessState.trim().toLowerCase() === "blocked";
}

/** Convert a blocked-run error payload into a user-facing wait/status message. */
export function formatBlockedLivenessError(error: unknown): string {
  const message = typeof error === "string" ? error.trim() : "";
  return message || "Agent run blocked before producing a usable result.";
}

/** Coerce any blocked liveness state into an error status while preserving other statuses. */
export function normalizeBlockedLivenessWaitStatus<
  TStatus extends "ok" | "error" | "timeout" | "pending",
>(params: {
  status: TStatus;
  livenessState?: unknown;
  error?: unknown;
}): { status: TStatus | "error"; error?: string } {
  const error = typeof params.error === "string" ? params.error : undefined;
  if (!isBlockedLivenessState(params.livenessState)) {
    return { status: params.status, error };
  }
  return {
    status: "error",
    error: formatBlockedLivenessError(error),
  };
}
