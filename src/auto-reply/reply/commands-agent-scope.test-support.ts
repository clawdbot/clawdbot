import { vi } from "vitest";

export const resolveSessionAgentIdMock = vi.fn(() => "main");
export const resolveAgentDirMock = vi.fn(
  (_cfg: unknown, agentId: string) => `/tmp/workspace/.openclaw/agents/${agentId}/agent`,
);

vi.doMock("../../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/agent-scope.js")>(
    "../../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveSessionAgentId: resolveSessionAgentIdMock,
    resolveAgentDir: resolveAgentDirMock,
  };
});
