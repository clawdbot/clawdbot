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

describe("subagent spawn depth + child limits", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
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

    expect(result).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 1, max: 1)",
    });
  });

  it("allows depth-1 callers when maxSpawnDepth is 2 and patches child capabilities", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      runId: "run-1",
    });

    const childSession = persistedStore?.[result.childSessionKey as string];
    expect(childSession).toMatchObject({
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
    });
    expect(typeof childSession?.spawnedWorkspaceDir).toBe("string");
  });

  it("rejects callers when stored spawn depth is already at the configured max", async () => {
    hoisted.configOverride = createDepthLimitConfig({ maxSpawnDepth: 2 });
    hoisted.depthBySession.set("agent:main:subagent:flat-depth-2", 2);

    const result = await spawnFrom("agent:main:subagent:flat-depth-2");

    expect(result).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 2, max: 2)",
    });
  });

  it("rejects when active children for requester session reached maxChildrenPerAgent", async () => {
    hoisted.configOverride = createDepthLimitConfig({
      maxSpawnDepth: 2,
      maxChildrenPerAgent: 1,
    });
    hoisted.depthBySession.set("agent:main:subagent:parent", 1);
    hoisted.activeChildrenBySession.set("agent:main:subagent:parent", 1);

    const result = await spawnFrom("agent:main:subagent:parent");

    expect(result).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn has reached max active children for this session (1/1)",
    });
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

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
    });
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

    expect(result).toMatchObject({
      status: "error",
    });
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
