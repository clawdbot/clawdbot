import "./agent-runner-memory.js";

type AgentRunnerMemoryTestApi = {
  setAgentRunnerMemoryTestDeps(overrides?: Record<string, unknown>): void;
};

function getTestApi(): AgentRunnerMemoryTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.agentRunnerMemoryTestApi")
  ];
  if (!api) {
    throw new Error("agent runner memory test API is unavailable");
  }
  return api as AgentRunnerMemoryTestApi;
}

export function setAgentRunnerMemoryTestDeps(overrides?: Record<string, unknown>): void {
  getTestApi().setAgentRunnerMemoryTestDeps(overrides);
}
