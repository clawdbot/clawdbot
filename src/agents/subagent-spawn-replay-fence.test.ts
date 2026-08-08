import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const getSwarmRunByLaunchReplayKey = vi.fn();
const hoisted = vi.hoisted(() => ({
  registerSubagentRunMock: vi.fn(),
  callGatewayMock: vi.fn(),
  dispatchGatewayMethodInProcessMock: vi.fn(),
  hasInProcessGatewayContextMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  loadPreparedModelCatalogMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  completeCollectorLaunchCleanupMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  resolveContextEngineMock: vi.fn(),
  countActiveRunsForSessionMock: vi.fn(),
  listSwarmRunsForGroupMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
}));

let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("sessions_spawn replay fence", () => {
  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      dispatchGatewayMethodInProcessMock: hoisted.dispatchGatewayMethodInProcessMock,
      hasInProcessGatewayContextMock: hoisted.hasInProcessGatewayContextMock,
      getRuntimeConfig: () => hoisted.configOverride,
      loadSessionStoreMock: hoisted.loadSessionStoreMock,
      loadPreparedModelCatalogMock: hoisted.loadPreparedModelCatalogMock,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      startQueuedSubagentRunMock: hoisted.startQueuedSubagentRunMock,
      settleFailedQueuedSubagentLaunchMock: hoisted.settleFailedQueuedSubagentLaunchMock,
      completeCollectorLaunchCleanupMock: hoisted.completeCollectorLaunchCleanupMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
      listSwarmRunsForGroup: hoisted.listSwarmRunsForGroupMock,
      getSwarmRunByLaunchReplayKey,
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      sessionStorePath: "/tmp/subagent-spawn-replay-fence.json",
    }));
  });

  beforeEach(() => {
    hoisted.configOverride = createSubagentSpawnTestConfig(os.tmpdir(), {
      tools: { swarm: true },
      agents: {
        list: [{ id: "main", workspace: os.tmpdir() }],
      },
    });
    hoisted.registerSubagentRunMock.mockReset();
    getSwarmRunByLaunchReplayKey.mockReset();
    getSwarmRunByLaunchReplayKey.mockReturnValue({
      runId: "swarm_existing",
      swarmRunId: "swarm_existing",
      childSessionKey: "agent:main:subagent:existing",
      collect: true,
      spawnMode: "run",
      swarmLaunchRequestFingerprint: "sha256:request",
    } as SubagentRunRecord);
    hoisted.callGatewayMock.mockReset();
    hoisted.callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      return { ok: true };
    });
    hoisted.loadSessionStoreMock.mockReturnValue({});
    hoisted.loadPreparedModelCatalogMock.mockReset().mockResolvedValue([]);
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    hoisted.countActiveRunsForSessionMock.mockReturnValue(0);
    hoisted.listSwarmRunsForGroupMock.mockReset().mockReturnValue([]);
  });

  it("returns the persisted collector identity without registering a duplicate run", async () => {
    const replay = await spawnSubagentDirect(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(getSwarmRunByLaunchReplayKey).toHaveBeenCalledWith(
      "cm-restart:bridge:1",
      "agent:main:main",
    );
    expect(replay).toMatchObject({
      status: "accepted",
      runId: "swarm_existing",
      childSessionKey: "agent:main:subagent:existing",
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.listSwarmRunsForGroupMock).not.toHaveBeenCalled();
  });

  it("fails closed when the replay key and fingerprint are not supplied as a pair", async () => {
    const replay = await spawnSubagentDirect(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(replay).toMatchObject({
      status: "error",
      error: expect.stringContaining("must be supplied together"),
    });
    expect(getSwarmRunByLaunchReplayKey).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("fails closed on a persisted fingerprint mismatch before admission", async () => {
    hoisted.listSwarmRunsForGroupMock.mockReturnValue(
      Array.from({ length: 100 }, (_, index) => ({
        runId: `existing-${index}`,
        collect: true,
        execution: { status: "terminal" },
        collectorCompletion: { status: "done" },
      })),
    );

    const replay = await spawnSubagentDirect(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:different",
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(replay).toMatchObject({
      status: "error",
      error: expect.stringContaining("does not match the persisted collector"),
    });
    expect(hoisted.listSwarmRunsForGroupMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });
});
