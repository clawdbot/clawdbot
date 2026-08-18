type YieldCompletionClaim = () => boolean | Promise<boolean>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  claimYieldCompletion?: YieldCompletionClaim;
}): YieldCompletionClaim | undefined {
  const hasRegistryClaim = Boolean(params.requesterSessionKey && params.requesterTurnRunId);
  if (!params.claimYieldCompletion && !hasRegistryClaim) {
    return undefined;
  }
  return async () => {
    // Runtime claims are observational. Check them before durable registry state
    // so a runtime failure cannot record a yield that never reaches onYield.
    const runtimeClaimed = (await params.claimYieldCompletion?.()) ?? false;
    if (!hasRegistryClaim) {
      return runtimeClaimed;
    }
    const { markRequesterTurnYielded } = await import("./subagents/registry/subagent-registry.js");
    const registryClaimed =
      markRequesterTurnYielded({
        requesterSessionKey: params.requesterSessionKey as string,
        requesterAgentId: params.requesterAgentId,
        requesterTurnRunId: params.requesterTurnRunId as string,
      }) > 0;
    return runtimeClaimed || registryClaimed;
  };
}
