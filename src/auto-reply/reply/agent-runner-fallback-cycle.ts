import { runAgentFallbackCandidates } from "./agent-runner-fallback-candidate.js";
import type {
  AgentFallbackCycleParams,
  AgentFallbackCycleResult,
} from "./agent-runner-fallback-cycle.types.js";
import { settleAgentFallbackCycle } from "./agent-runner-fallback-settlement.js";

export type { AgentFallbackCycleState } from "./agent-runner-fallback-cycle.types.js";

/** Runs one fallback chain, then settles its terminal lifecycle state. */
export async function executeAgentFallbackCycle(
  params: AgentFallbackCycleParams,
): Promise<AgentFallbackCycleResult> {
  const fallbackResult = await runAgentFallbackCandidates(params);
  params.timing.logIfSlow({
    runId: params.runId,
    sessionId: params.turn.followupRun.run.sessionId,
    sessionKey: params.turn.sessionKey,
    outcome: "completed",
  });
  return settleAgentFallbackCycle({ cycle: params, fallbackResult });
}
