import type { EmbeddedAgentExecutionPhase } from "../../agents/embedded-agent-runner/execution-phase.js";
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
  const observedExecutionPhases = new Set<EmbeddedAgentExecutionPhase>();
  const timing = createReplyTimingTracker<AgentTurnLogParams>({
    log: {
      warn(message, details) {
        const isOutputMilestone =
          details?.milestone === "assistant_output_started" ||
          details?.milestone === "tool_execution_started";
        // Provider and tool latency is useful context, not a startup warning.
        if (isOutputMilestone && !options.profilerEnabled) {
          agentTurnTimingLog.info(message, details);
        } else {
          agentTurnTimingLog.warn(message, details);
        }
      },
    },
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
      // The terminal duration includes inference and tools; default warnings
      // belong to the preparation and first-activity milestones below.
      if (!options.profilerEnabled) {
        return;
      }
      const { runId, sessionId, sessionKey, outcome, error } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, outcome, error });
    },
    logMilestoneIfSlow(params: AgentTurnMilestoneLogParams) {
      const { runId, sessionId, sessionKey, milestone } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, milestone }, { repeat: true });
    },
    logExecutionPhaseIfSlow(params: AgentTurnLogContext & { phase: EmbeddedAgentExecutionPhase }) {
      // Each phase is a first-observation boundary, not a log for every tool
      // or retry. The fixed phase vocabulary bounds this per-turn state.
      if (observedExecutionPhases.has(params.phase)) {
        return;
      }
      observedExecutionPhases.add(params.phase);
      const { runId, sessionId, sessionKey, phase: milestone } = params;
      timing.logIfSlow({ runId, sessionId, sessionKey, milestone }, { repeat: true });
    },
  };
}

export type AgentTurnTimingTracker = ReturnType<typeof createAgentTurnTimingTracker>;
