import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  activeChildrenBySession: new Map<string, number>(),
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  depthBySession: new Map<string, number>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let persistedStore: Record<string, Record<string, unknown>> | undefined;

type SpawnResult = Awaited<ReturnType<typeof spawnSubagentDirect>>;
type AcceptedSpawnResult = SpawnResult & {
  childSessionKey: string;
  runId: string;
  status: "accepted";
};

function createDepthLimitConfig(subagents?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig("/tmp/workspace-main", {
    agents: {
      defaults: {
        workspace: "/tmp/workspace-main",
        subagents: {
          maxSpawnDepth: 1,
          ...subagents,
        },
      },
    },
  });
}

async function spawnFrom(sessionKey: string, params?: Record<string, unknown>) {
  return await spawnSubagentDirect(
    {
      task: "hello",
      ...params,
    },
    {
      agentSessionKey: sessionKey,
      workspaceDir: "/tmp/workspace-main",
    },
  );
}

function expectForbidden(result: SpawnResult, error: string) {
  expect(result.status).toBe("forbidden");
  if (result.status !== "forbidden") {
    throw new Error(`Expected forbidden spawn result, received ${result.status}`);
  }
  expect(result.error).toBe(error);
}

function expectAccepted(result: SpawnResult, runId: string): AcceptedSpawnResult {
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error(`Expected accepted spawn result, received ${result.status}`);
  }
  expect(result.runId).toBe(runId);
  expect(typeof result.childSessionKey).toBe("string");
  return result as AcceptedSpawnResult;
}

describe("subagent spawn depth + child limits", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      getRuntimeConfig: () => hoisted.configOverride,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      getSubagentDepthFromSessionStore: (sessionKey) => hoisted.depthBySession.get(sessionKey) ?? 0,
      countActiveRunsForSession: (sessionKey) =>
        hoisted.activeChildrenBySession.get(sessionKey) ?? 0,
      resetModules: false,
    }));
  });

  beforeEach(() => {
    hoisted.activeChildrenBySession.clear();
    hoisted.depthBySession.clear();
    hoisted.callGatewayMock.mockClear();
    hoisted.registerSubagentRunMock.mockClear();
    hoisted.updateSessionStoreMock.mockReset();
    persistedStore = undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });
    hoisted.configOverride = createDepthLimitConfig();
    setupAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
  });

  it("rejects spawning when caller depth reaches maxSpawnDepth", async () => {
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    expectForbidden(
      result,
      "sessions_spawn is not allowed at this depth (current depth: 1, max: 1)",
    );
  });

  it("allows depth-1 callers when maxSpawnDepth is 2 and patches child capabilities", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    const accepted = expectAccepted(result, "run-1");
    expect(accepted.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSession = persistedStore?.[accepted.childSessionKey];
    if (!childSession) {
      throw new Error("Expected persisted child session");
    }
    expect(childSession.spawnedBy).toBe("agent:main:subagent:parent");
    expect(childSession.spawnDepth).toBe(2);
    expect(childSession.subagentRole).toBe("leaf");
    expect(childSession.subagentControlScope).toBe("none");
    expect(typeof childSession?.spawnedWorkspaceDir).toBe("string");
  });

  it("persists inherited tool denies on spawned child sessions", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });

    const result = await spawnSubagentDirect(
      {
        task: "hello",
      },
      {
        agentSessionKey: "agent:main:main",
        workspaceDir: "/tmp/workspace-main",
        inheritedToolAllowlist: ["sessions_spawn", "read", ""],
        inheritedToolDenylist: ["bash", "exec", "read", ""],
      },
    );

    const accepted = expectAccepted(result, "run-1");
    const childSession = persistedStore?.[accepted.childSessionKey];
    if (!childSession) {
      throw new Error("Expected persisted child session");
    }
    expect(childSession.inheritedToolAllow).toEqual(["sessions_spawn", "read"]);
    expect(childSession.inheritedToolDeny).toEqual(["exec", "read"]);
  });

  it("rejects callers when stored spawn depth is already at the configured max", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });
    hoisted.depthBySession.set("agent:main:subagent:flat-depth-2", 2);

    const result = await spawnFrom("agent:main:subagent:flat-depth-2");

    expectForbidden(
      result,
      "sessions_spawn is not allowed at this depth (current depth: 2, max: 2)",
    );
  });

  it("rejects when active children for requester session reached maxChildrenPerAgent", async () => {
    hoisted.configOverride = createDepthLimitConfig({
      maxSpawnDepth: 2,
      maxChildrenPerAgent: 1,
    });
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);
    hoisted.activeChildrenBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    expectForbidden(
      result,
      "sessions_spawn has reached max active children for this session (1/1)",
    );
  });

  it("does not use subagent maxConcurrent as a per-parent spawn gate", async () => {
    hoisted.configOverride = createDepthLimitConfig({
      maxSpawnDepth: 2,
      maxChildrenPerAgent: 5,
      maxConcurrent: 1,
    });
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);
    hoisted.activeChildrenBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    expectAccepted(result, "run-1");
  });

  it("fails spawn when the initial child session patch rejects the model", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });
    hoisted.callGatewayMock.mockImplementation(
      async (opts: { method?: string; params?: { model?: string } }) => {
        if (opts.method === "agent") {
          return { runId: "run-depth" };
        }
        return {};
      },
    );
    hoisted.updateSessionStoreMock.mockRejectedValueOnce(new Error("invalid model: bad-model"));

    const result = await spawnFrom("main", { model: "bad-model" });

    expect(result.status).toBe("error");
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
