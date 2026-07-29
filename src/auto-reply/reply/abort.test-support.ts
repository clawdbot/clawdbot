import "./abort.js";

type AbortTestDeps = {
  getAcpSessionManager: typeof import("../../acp/control-plane/manager.js").getAcpSessionManager;
  abortEmbeddedAgentRun: typeof import("../../agents/embedded-agent-runner/runs.js").abortEmbeddedAgentRun;
  resolveActiveEmbeddedRunSessionId: typeof import("../../agents/embedded-agent-runner/runs.js").resolveActiveEmbeddedRunSessionId;
  markSessionAbortTarget: typeof import("../../config/sessions/session-accessor.js").markSessionAbortTarget;
  resolveSessionAbortTarget: typeof import("../../config/sessions/session-accessor.js").resolveSessionAbortTarget;
  getLatestSubagentRunByChildSessionKey: typeof import("../../agents/subagent-registry.js").getLatestSubagentRunByChildSessionKey;
  listSubagentRunsForController: typeof import("../../agents/subagent-registry.js").listSubagentRunsForController;
  markSubagentRunTerminated: typeof import("../../agents/subagent-registry.js").markSubagentRunTerminated;
};

type AbortTestApi = {
  setDepsForTests(deps: Partial<AbortTestDeps> | undefined): void;
  resetDepsForTests(): void;
};

function getTestApi(): AbortTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.abortTestApi")];
  if (!api) {
    throw new Error("abort test API is unavailable");
  }
  return api as AbortTestApi;
}

export const testing = {
  setDepsForTests(deps: Partial<AbortTestDeps> | undefined): void {
    getTestApi().setDepsForTests(deps);
  },
  resetDepsForTests(): void {
    getTestApi().resetDepsForTests();
  },
};
