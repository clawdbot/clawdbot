import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";

type AgentTurnLogContext = {
  runId: string;
  sessionId?: string;
  sessionKey?: string;
};
type AgentTurnTerminalLogParams = AgentTurnLogContext & {
  outcome: "completed" | "error";
  error?: string;
};
type AgentTurnMilestoneLogParams = AgentTurnLogContext & { milestone: string };
type AgentTurnLogParams = AgentTurnTerminalLogParams | AgentTurnMilestoneLogParams;

const agentTurnTimingLog = createSubsystemLogger("auto-reply/agent-turn-timing");

export function createAgentTurnTimingTracker(options: { profilerEnabled?: boolean } = {}) {
  const timing = createReplyTimingTracker<AgentTurnLogParams>({
    log: agentTurnTimingLog,
    enabled: options.profilerEnabled === true,
    formatMessage: (params, summary, stages) => {
      const identity = `runId=${params.runId} sessionId=${params.sessionId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"}`;
      return "milestone" in params
        ? `agent turn milestone ${identity} milestone=${params.milestone} totalMs=${summary.totalMs} stages=${stages}`
        : `agent turn timings ${identity} outcome=${params.outcome} totalMs=${summary.totalMs} stages=${stages}${params.error ? ` error="${params.error}"` : ""}`;
    },
    detailKeys: (params) =>
      "milestone" in params
        ? ["runId", "sessionId", "sessionKey", "milestone"]
        : ["runId", "sessionId", "sessionKey", "outcome", "error"],
  });
  return {
    measure: timing.measure,
    measureSync: timing.measureSync,
    logIfSlow(params: AgentTurnTerminalLogParams) {
      const { runId, sessionId, sessionKey, outcome, error } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, outcome, error });
    },
    logMilestoneIfSlow(params: AgentTurnMilestoneLogParams) {
      const { runId, sessionId, sessionKey, milestone } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, milestone }, { repeat: true });
    },
  };
}

export type AgentTurnTimingTracker = ReturnType<typeof createAgentTurnTimingTracker>;
