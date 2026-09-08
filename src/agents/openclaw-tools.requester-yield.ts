import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";

/**
 * Isolated automation (cron) requesters are never woken by requester settle
 * (see subagent-announce.requester-settle-wake), so an accepted yield would
 * strand the turn: yield intent is recorded, the run finalizes before required
 * descendants settle, and the continuation never arrives (#135282).
 */
const ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR =
  "Isolated automation turns do not support sessions_yield because no continuation owner resumes this session. Keep required child work bounded in this turn; spawned descendants deliver output through the scheduler-owned completion wait.";

type YieldCompletionClaim = () =>
  | boolean
  | { error: string }
  | Promise<boolean | { error: string }>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  claimYieldCompletion?: () => boolean | Promise<boolean>;
}): YieldCompletionClaim | undefined {
  // Backstop: createOpenClawTools does not assemble sessions_yield for cron
  // requesters at all (the capability is unavailable, not merely rejected), so
  // this lifecycle-boundary rejection guards against any future
  // re-introduction path recording a stranded durable yield intent.
  if (isCronSessionKey(params.requesterSessionKey)) {
    return () => ({ error: ISOLATED_AUTOMATION_YIELD_UNSUPPORTED_ERROR });
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
