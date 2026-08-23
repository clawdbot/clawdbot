import "./agent-runner-session-reset.js";

type AgentRunnerSessionResetTestApi = {
  setAgentRunnerSessionResetTestDeps(overrides?: Record<string, unknown>): void;
};

function getTestApi(): AgentRunnerSessionResetTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentRunnerSessionResetTestApi")
  ];
  if (!api) {
    throw new Error("agent runner session reset test API is unavailable");
  }
  return api as AgentRunnerSessionResetTestApi;
}

export function setAgentRunnerSessionResetTestDeps(overrides?: Record<string, unknown>): void {
  getTestApi().setAgentRunnerSessionResetTestDeps(overrides);
}
