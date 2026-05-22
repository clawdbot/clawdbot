export function isBlockedLivenessState(livenessState: unknown): boolean {
  return typeof livenessState === "string" && livenessState.trim().toLowerCase() === "blocked";
}

export function formatBlockedLivenessError(error: unknown): string {
  const message = typeof error === "string" ? error.trim() : "";
  return message || "Agent run blocked before producing a usable result.";
}

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
