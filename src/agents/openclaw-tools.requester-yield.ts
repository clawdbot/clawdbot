import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";

type YieldCompletionClaim = () => boolean | Promise<boolean>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  claimYieldCompletion?: YieldCompletionClaim;
}): YieldCompletionClaim | undefined {
  // Cron automations have no durable continuation owner for a yielded turn; the
  // completion wake is deliberately skipped for them. Reject the yield before any
  // intent is recorded so the automation never reports success while its required
  // child work remains unresolved.
  if (isCronSessionKey(params.requesterSessionKey)) {
    return undefined;
  }
  const selfClaimed = isSubagentSessionKey(params.requesterSessionKey);
  const hasRegistryClaim = Boolean(params.requesterSessionKey && params.requesterTurnRunId);
  if (!params.claimYieldCompletion && !selfClaimed && !hasRegistryClaim) {
    return undefined;
  }
  return async () => {
    // Runtime claims are observational. Check them before durable registry state
    // so a runtime failure cannot record a yield that never reaches onYield.
    const runtimeClaimed = (await params.claimYieldCompletion?.()) ?? false;
    if (!hasRegistryClaim) {
      return runtimeClaimed || selfClaimed;
    }
    const { markRequesterTurnYielded } = await import("./subagents/registry/subagent-registry.js");
    const registryClaimed =
      markRequesterTurnYielded({
        requesterSessionKey: params.requesterSessionKey as string,
        requesterAgentId: params.requesterAgentId,
        requesterTurnRunId: params.requesterTurnRunId as string,
      }) > 0;
    return runtimeClaimed || selfClaimed || registryClaimed;
  };
}
