/**
 * Builds the inherited requester-settle wake for a successor spawned from a yielded wake.
 * The retained requester wake remains responsible for the original user's final response.
 */
export function resolveInheritedRequesterSettleWake(
  requesterTurnRunId: string | undefined,
  runId: string,
) {
  if (!/^announce:requester-settle:.*:yield-\d+$/u.test(requesterTurnRunId ?? "")) {
    return undefined;
  }
  return {
    status: "pending" as const,
    attemptCount: 0,
    batchRunIds: [runId],
    requesterYieldBatch: true as const,
    afterRequesterYield: true as const,
  };
}
