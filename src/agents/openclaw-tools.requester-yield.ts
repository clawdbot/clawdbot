export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
}): (() => Promise<void>) | undefined {
  if (!params.requesterSessionKey || !params.requesterTurnRunId) {
    return undefined;
  }
  return async () => {
    const { markRequesterTurnYielded } = await import("./subagents/registry/subagent-registry.js");
    markRequesterTurnYielded({
      requesterSessionKey: params.requesterSessionKey as string,
      requesterAgentId: params.requesterAgentId,
      requesterTurnRunId: params.requesterTurnRunId as string,
    });
  };
}
