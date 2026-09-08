/** Projects closed execution independently of later reply delivery. */
export function resolveAgentTurnExecutionStatus(
  outcome?: { kind: "aborted" | "rejected" } | { kind: "settled"; status: "ok" | "failed" },
) {
  if (outcome?.kind === "settled") {
    return outcome.status;
  }
  return outcome?.kind === "aborted" ? "cancelled" : "failed";
}
