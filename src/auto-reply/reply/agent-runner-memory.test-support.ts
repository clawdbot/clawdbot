import "./agent-runner-memory.js";

type AgentRunnerMemoryTestApi = {
  setAgentRunnerMemoryTestDeps(overrides?: Record<string, unknown>): void;
  ensureMemoryFlushTargetFile(params: {
    workspaceDir: string;
    relativePath: string;
  }): Promise<void>;
  readMemoryFlushTargetFile(params: {
    workspaceDir: string;
    relativePath: string;
  }): Promise<string>;
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

export const memoryFlushTargetTestApi = {
  ensure: (params: { workspaceDir: string; relativePath: string }) =>
    getTestApi().ensureMemoryFlushTargetFile(params),
  read: (params: { workspaceDir: string; relativePath: string }) =>
    getTestApi().readMemoryFlushTargetFile(params),
};
