import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentLocalStatuses } from "./status.agent-local.js";

const mocks = vi.hoisted(() => ({
  listGatewayAgentsBasic: vi.fn(),
}));

vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/${agentId}`,
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_store: unknown, scope: { agentId: string }) =>
    `/tmp/${scope.agentId}/sessions.json`,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntriesReadOnly: () => [],
}));
vi.mock("../infra/fs-safe.js", () => ({ pathExists: async () => false }));

describe("getAgentLocalStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not project the gateway's compatibility id as an explicit fleet default", async () => {
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "alpha",
      ownership: "explicit",
      selectionRequired: true,
      agents: [{ id: "alpha" }, { id: "beta" }],
    });

    await expect(getAgentLocalStatuses({})).resolves.toMatchObject({
      defaultId: null,
      ownership: "explicit",
      selectionRequired: true,
      agents: [{ id: "alpha" }, { id: "beta" }],
    });
  });

  it("preserves a resolved sole owner", async () => {
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "alpha",
      ownership: "sole",
      selectionRequired: false,
      agents: [{ id: "alpha" }],
    });

    await expect(getAgentLocalStatuses({})).resolves.toMatchObject({
      defaultId: "alpha",
      ownership: "sole",
      selectionRequired: false,
      agents: [{ id: "alpha", sessionsPath: "/tmp/alpha/openclaw-agent.alpha.sqlite" }],
    });
  });
});
