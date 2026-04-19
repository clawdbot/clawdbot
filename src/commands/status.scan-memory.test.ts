import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveMemorySearchConfig: vi.fn(),
  getMemorySearchManager: vi.fn(),
  resolveSharedMemoryStatusSnapshot: vi.fn(),
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: mocks.resolveMemorySearchConfig,
}));

vi.mock("./status.scan.deps.runtime.js", () => ({
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

vi.mock("./status.scan.shared.js", () => ({
  resolveSharedMemoryStatusSnapshot: mocks.resolveSharedMemoryStatusSnapshot,
}));

function createMainAgentStatus() {
  return {
    defaultId: "main",
    totalSessions: 0,
    bootstrapPendingCount: 0,
    agents: [
      {
        id: "main",
        workspaceDir: null,
        bootstrapPending: false,
        sessionsPath: "/tmp/main.json",
        sessionsCount: 0,
        lastUpdatedAt: null,
        lastActiveAgeMs: null,
      },
    ],
  };
}

describe("status.scan-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSharedMemoryStatusSnapshot.mockResolvedValue({ agentId: "main" });
  });

  it("forwards the shared memory snapshot dependencies", async () => {
    const { resolveStatusMemoryStatusSnapshot } = await import("./status.scan-memory.ts");

    const requireDefaultStore = vi.fn((agentId: string) => `/tmp/${agentId}.sqlite`);
    const agentStatus = createMainAgentStatus();
    await resolveStatusMemoryStatusSnapshot({
      cfg: { agents: {} },
      agentStatus,
      memoryPlugin: { enabled: true, slot: "memory-core" },
      requireDefaultStore,
    });

    expect(mocks.resolveSharedMemoryStatusSnapshot).toHaveBeenCalledWith({
      cfg: { agents: {} },
      agentStatus,
      memoryPlugin: { enabled: true, slot: "memory-core" },
      resolveMemoryConfig: mocks.resolveMemorySearchConfig,
      getMemorySearchManager: mocks.getMemorySearchManager,
      requireDefaultStore,
    });
  });
});
