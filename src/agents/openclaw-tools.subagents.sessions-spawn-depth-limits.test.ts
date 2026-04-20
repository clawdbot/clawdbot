import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../tasks/task-executor.js", () => ({
  completeTaskRunByRunId: vi.fn(),
  createQueuedTaskRun: vi.fn(),
  createRunningTaskRun: vi.fn(),
  failTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
  startTaskRunByRunId: vi.fn(),
}));

let storeTemplatePath = "";
let configOverride: Record<string, unknown> = {
  session: createPerSenderSessionConfig(),
};
let addSubagentRunForTests: typeof import("./subagent-registry.js").addSubagentRunForTests;
let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let subagentRegistryTesting: typeof import("./subagent-registry.js").__testing;
let setSubagentSpawnDepsForTest: typeof import("./subagent-spawn.js").__testing.setDepsForTest;
let createSessionsSpawnTool: typeof import("./tools/sessions-spawn-tool.js").createSessionsSpawnTool;

vi.mock("../config/config.js", () => ({
  loadConfig: () => configOverride,
}));

function writeStore(agentId: string, store: Record<string, unknown>) {
  const storePath = storeTemplatePath.replaceAll("{agentId}", agentId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

function setSubagentLimits(subagents: Record<string, unknown>) {
  configOverride = {
    session: createPerSenderSessionConfig({ store: storeTemplatePath }),
    agents: {
      defaults: {
        subagents,
      },
    },
  };
}

function seedDepthTwoAncestryStore(params?: { sessionIds?: boolean }) {
  const depth1 = "agent:main:subagent:depth-1";
  const callerKey = "agent:main:subagent:depth-2";
  writeStore("main", {
    [depth1]: {
      sessionId: params?.sessionIds ? "depth-1-session" : "depth-1",
      updatedAt: Date.now(),
      spawnedBy: "agent:main:main",
    },
    [callerKey]: {
      sessionId: params?.sessionIds ? "depth-2-session" : "depth-2",
      updatedAt: Date.now(),
      spawnedBy: depth1,
    },
  });
  return { depth1, callerKey };
}

beforeAll(async () => {
  ({
    __testing: subagentRegistryTesting,
    addSubagentRunForTests,
    resetSubagentRegistryForTests,
  } = await import("./subagent-registry.js"));
  ({
    __testing: { setDepsForTest: setSubagentSpawnDepsForTest },
  } = await import("./subagent-spawn.js"));
  ({ createSessionsSpawnTool } = await import("./tools/sessions-spawn-tool.js"));
});

describe("sessions_spawn depth + child limits", () => {
  beforeEach(() => {
    setSubagentSpawnDepsForTest({
      callGateway: (opts) => callGatewayMock(opts),
      getGlobalHookRunner: () => null,
    });
    subagentRegistryTesting.setDepsForTest({
      captureSubagentCompletionReply: () => Promise.resolve(undefined),
      cleanupBrowserSessionsForLifecycleEnd: () => Promise.resolve(),
      ensureRuntimePluginsLoaded: () => {},
      onAgentEvent: () => () => {},
      persistSubagentRunsToDisk: () => {},
      resolveAgentTimeoutMs: () => 1,
      runSubagentAnnounceFlow: () => Promise.resolve(true),
    });
    resetSubagentRegistryForTests({ persist: false });
    callGatewayMock.mockClear();
    storeTemplatePath = path.join(
      os.tmpdir(),
      `openclaw-subagent-depth-${Date.now()}-${Math.random().toString(16).slice(2)}-{agentId}.json`,
    );
    configOverride = {
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string };
      if (req.method === "agent") {
        return { runId: "run-depth" };
      }
      if (req.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    subagentRegistryTesting.setDepsForTest();
  });

  afterAll(() => {
    setSubagentSpawnDepsForTest();
  });

  it("rejects spawning when caller depth reaches maxSpawnDepth", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      workspaceDir: "/parent/workspace",
    });
    const result = await tool.execute("call-depth-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 1, max: 1)",
    });
  });

  it("allows depth-1 callers when maxSpawnDepth is 2", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });

    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-depth-allow", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      runId: "run-depth",
    });

    const calls = callGatewayMock.mock.calls.map(
      (call) => call[0] as { method?: string; params?: Record<string, unknown> },
    );
    const spawnedByPatch = calls.find(
      (entry) =>
        entry.method === "sessions.patch" &&
        entry.params?.spawnedBy === "agent:main:subagent:parent",
    );
    expect(spawnedByPatch?.params?.key).toMatch(/^agent:main:subagent:/);
    expect(typeof spawnedByPatch?.params?.spawnedWorkspaceDir).toBe("string");

    const spawnDepthPatch = calls.find(
      (entry) => entry.method === "sessions.patch" && entry.params?.spawnDepth === 2,
    );
    expect(spawnDepthPatch?.params?.key).toMatch(/^agent:main:subagent:/);
    expect(spawnDepthPatch?.params?.subagentRole).toBe("leaf");
    expect(spawnDepthPatch?.params?.subagentControlScope).toBe("none");
  });

  it("rejects depth-2 callers when maxSpawnDepth is 2 (using stored spawnDepth on flat keys)", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });

    const callerKey = "agent:main:subagent:flat-depth-2";
    writeStore("main", {
      [callerKey]: {
        sessionId: "flat-depth-2",
        updatedAt: Date.now(),
        spawnDepth: 2,
      },
    });

    const tool = createSessionsSpawnTool({ agentSessionKey: callerKey });
    const result = await tool.execute("call-depth-2-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 2, max: 2)",
    });
  });

  it("rejects depth-2 callers when spawnDepth is missing but spawnedBy ancestry implies depth 2", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    const { callerKey } = seedDepthTwoAncestryStore();

    const tool = createSessionsSpawnTool({ agentSessionKey: callerKey });
    const result = await tool.execute("call-depth-ancestry-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 2, max: 2)",
    });
  });

  it("rejects depth-2 callers when the requester key is a sessionId", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    seedDepthTwoAncestryStore({ sessionIds: true });

    const tool = createSessionsSpawnTool({ agentSessionKey: "depth-2-session" });
    const result = await tool.execute("call-depth-sessionid-reject", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn is not allowed at this depth (current depth: 2, max: 2)",
    });
  });

  it("rejects when active children for requester session reached maxChildrenPerAgent", async () => {
    configOverride = {
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 1,
          },
        },
      },
    };

    addSubagentRunForTests({
      runId: "existing-run",
      childSessionKey: "agent:main:subagent:existing",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
      task: "existing",
      cleanup: "keep",
      createdAt: Date.now(),
      startedAt: Date.now(),
    });

    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-max-children", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "sessions_spawn has reached max active children for this session (1/1)",
    });
  });

  it("does not double-count restarted child sessions toward maxChildrenPerAgent", async () => {
    configOverride = {
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 2,
          },
        },
      },
    };

    const childSessionKey = "agent:main:subagent:restarted-child";
    addSubagentRunForTests({
      runId: "existing-old-run",
      childSessionKey,
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
      task: "old orchestration run",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
      endedAt: Date.now() - 20_000,
      cleanupCompletedAt: undefined,
    });
    addSubagentRunForTests({
      runId: "existing-current-run",
      childSessionKey,
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
      task: "current orchestration run",
      cleanup: "keep",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 10_000,
    });
    addSubagentRunForTests({
      runId: "existing-descendant-run",
      childSessionKey: `${childSessionKey}:subagent:leaf`,
      requesterSessionKey: childSessionKey,
      requesterDisplayKey: childSessionKey,
      task: "descendant still running",
      cleanup: "keep",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 5_000,
    });

    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-max-children-dedupe", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-depth",
    });
  });

  it("does not use subagent maxConcurrent as a per-parent spawn gate", async () => {
    configOverride = {
      session: createPerSenderSessionConfig({ store: storeTemplatePath }),
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 5,
            maxConcurrent: 1,
          },
        },
      },
    };

    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:subagent:parent" });
    const result = await tool.execute("call-max-concurrent-independent", { task: "hello" });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-depth",
    });
  });

  it("fails spawn when sessions.patch rejects the model", async () => {
    setSubagentLimits({ maxSpawnDepth: 2 });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const req = opts as { method?: string; params?: { model?: string } };
      if (req.method === "sessions.patch" && req.params?.model === "bad-model") {
        throw new Error("invalid model: bad-model");
      }
      if (req.method === "agent") {
        return { runId: "run-depth" };
      }
      if (req.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    const tool = createSessionsSpawnTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-model-reject", {
      task: "hello",
      model: "bad-model",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect((result.details as { error?: string }).error ?? "").toContain("invalid model");
    expect(
      callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
