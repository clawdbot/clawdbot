import { createSubsystemLogger } from "../../logging/subsystem.js";

type AgentTurnTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type AgentTurnTimingSummary = {
  totalMs: number;
  spans: AgentTurnTimingSpan[];
};

export type AgentTurnTimingTracker = {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  logIfSlow: (params: {
    runId: string;
    sessionId?: string;
    sessionKey?: string;
    outcome: "completed" | "error";
    error?: string;
  }) => void;
  logMilestoneIfSlow: (params: {
    runId: string;
    sessionId?: string;
    sessionKey?: string;
    milestone: string;
  }) => void;
};

const agentTurnTimingLog = createSubsystemLogger("auto-reply/agent-turn-timing");
const AGENT_TURN_TIMING_WARN_TOTAL_MS = 1_000;
const AGENT_TURN_TIMING_WARN_STAGE_MS = 500;

/** Creates a no-overhead pass-through unless reply profiling is enabled. */
export function createAgentTurnTimingTracker(
  options: {
    profilerEnabled?: boolean;
  } = {},
): AgentTurnTimingTracker {
  if (!options.profilerEnabled) {
    // This tracker wraps the agent-turn hot path. Without an explicit profiler
    // flag, keep every wrapper pass-through so normal turns avoid Date.now and
    // span-array work entirely.
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      logIfSlow() {},
      logMilestoneIfSlow() {},
    };
  }

  const startedAt = Date.now();
  let didLog = false;
  const spans: AgentTurnTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    spans.push({
      name,
      durationMs: toMs(Date.now() - spanStartedAt),
      elapsedMs: toMs(Date.now() - startedAt),
    });
  };
  const snapshot = (): AgentTurnTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: AgentTurnTimingSummary) =>
    summary.totalMs >= AGENT_TURN_TIMING_WARN_TOTAL_MS ||
    summary.spans.some((span) => span.durationMs >= AGENT_TURN_TIMING_WARN_STAGE_MS);
  const formatSpans = (summary: AgentTurnTimingSummary) =>
    summary.spans.length > 0
      ? summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return {
    async measure(name, run) {
      const spanStartedAt = Date.now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = Date.now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    logIfSlow(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      agentTurnTimingLog.warn(
        `agent turn timings runId=${params.runId} sessionId=${
          params.sessionId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}${params.error ? ` error="${params.error}"` : ""}`,
        {
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          outcome: params.outcome,
          error: params.error,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
    logMilestoneIfSlow(params) {
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      agentTurnTimingLog.warn(
        `agent turn milestone runId=${params.runId} sessionId=${
          params.sessionId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} milestone=${params.milestone} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}`,
        {
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          milestone: params.milestone,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
  };
}
