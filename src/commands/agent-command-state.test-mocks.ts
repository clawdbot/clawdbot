// Shared hoisted state for the agent command test mocks.
import { vi } from "vitest";

const agentHarnessPluginMocks = vi.hoisted(() => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

export function getAgentHarnessPluginMocks() {
  return agentHarnessPluginMocks;
}
