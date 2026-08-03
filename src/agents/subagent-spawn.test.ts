// Subagent spawn tests cover target policy, session patching, runtime model
// persistence, registry registration, and lifecycle event emission.
import os from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { readReservedSubagentClaimToken } from "./reserved-subagent-admission.js";
import { resetSubagentSpawnAdmissionForTests } from "./subagent-spawn-admission.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { testing as swarmSchedulerTesting } from "./swarm-scheduler.test-support.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  loadPreparedModelCatalogMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  completeCollectorLaunchCleanupMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  dispatchGatewayMethodInProcessMock: vi.fn(),
  hasInProcessGatewayContextMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  resolveContextEngineMock: vi.fn(),
  countActiveRunsForSessionMock: vi.fn(),
  hasSubagentRunIdentityMock: vi.fn(),
  getLatestSubagentRunByChildSessionKeyMock: vi.fn(),
  quarantineFailedSubagentSpawnMock: vi.fn(),
  listSwarmRunsForGroupMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  hookRunner: null as null | {
    hasHooks?: (name: string) => boolean;
    runSubagentProgress?: (...args: unknown[]) => Promise<void>;
    runSubagentSpawned?: (...args: unknown[]) => Promise<void>;
    runSubagentEnded?: (...args: unknown[]) => Promise<void>;
  },
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let activateCollectorLaunch: typeof import("./subagent-collector-launch-failure.js").activateCollectorLaunch;
let retryRetainedContextEnginePreparationRollback: typeof import("./subagent-spawn-context.js").retryRetainedContextEnginePreparationRollback;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let spawnFailureQuarantine: typeof import("./subagent-spawn-failure-quarantine.js");
let reserveSwarmRun: typeof import("./swarm-scheduler.js").reserveSwarmRun;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function gatewayRequestRecords(): Record<string, unknown>[] {
  // Gateway calls are the seam proof for spawn orchestration; assertions inspect
  // structured requests instead of matching rendered text.
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function activateFailingCollectorLaunchForTest(params: {
  childRunId: string;
  childSessionKey: string;
  contextEnginePreparation?: { rollback: () => Promise<void> | void };
  error?: Error;
}) {
  const groupId = `swarm:${params.childRunId}`;
  reserveSwarmRun({
    activeRunIds: [],
    groupId,
    maxConcurrent: 1,
    runId: params.childRunId,
  });
  activateCollectorLaunch({
    childRunId: params.childRunId,
    childSessionKey: params.childSessionKey,
    contextEnginePreparation: params.contextEnginePreparation,
    emitSpawnLifecycleHooks: async () => {},
    groupId,
    launchChildRun: async () => {
      throw params.error ?? new Error("launch failed");
    },
    requesterInternalKey: "agent:main:main",
    threadBindingReady: true,
  });
}

function installActiveCountFromRegisteredRuns(extraRuns: Record<string, unknown>[] = []) {
  hoisted.countActiveRunsForSessionMock.mockImplementation(
    (sessionKey: string, options?: { collect?: boolean }) => {
      const latestByChild = new Map<string, Record<string, unknown>>();
      const records = [
        ...hoisted.registerSubagentRunMock.mock.calls.map((call) => requireRecord(call[0])),
        ...extraRuns,
      ];
      for (const record of records) {
        if (options?.collect !== undefined && (record.collect === true) !== options.collect) {
          continue;
        }
        const owner =
          typeof record.controllerSessionKey === "string"
            ? record.controllerSessionKey
            : record.requesterSessionKey;
        const childSessionKey =
          typeof record.childSessionKey === "string" ? record.childSessionKey : "";
        if (owner === sessionKey && childSessionKey) {
          latestByChild.set(childSessionKey, record);
        }
      }
      return latestByChild.size;
    },
  );
}

function spawnOrdinaryWorker(suffix: string, requesterSessionKey = "agent:main:main") {
  return spawnSubagentDirect(
    {
      task: `ordinary shared admission ${suffix}`,
      agentId: "worker",
      expectsCompletionMessage: false,
    },
    { agentSessionKey: requesterSessionKey },
  );
}

function spawnReservedWorker(suffix: string, requesterSessionKey = "agent:main:main") {
  return spawnSubagentDirect(
    {
      task: `reserved shared admission ${suffix}`,
      agentId: "worker",
      expectsCompletionMessage: false,
    },
    {
      agentSessionKey: requesterSessionKey,
      authorizedTargetAgentId: "worker",
      preallocatedChildSessionKey: `agent:worker:subagent:${suffix}`,
      preallocatedRunId: `run-${suffix}`,
      pluginOwnerId: "agentic-os",
      reservedSubagentClaimToken: `claim-${suffix}`,
    },
  );
}

type InheritedSpawnPreferenceCase = {
  name: string;
  task: string;
  requesterState: Readonly<Record<string, unknown>>;
  preferenceKey: "thinkingLevel" | "fastMode";
  expected: string | boolean;
  agentDefaults?: Readonly<Record<string, unknown>>;
  requesterAgent?: Readonly<Record<string, unknown>>;
  sessionStoreUnavailable?: boolean;
  swarmEnabled?: boolean;
  collect?: boolean;
  requesterRunId?: string;
};

const inheritedSpawnPreferenceCases: readonly InheritedSpawnPreferenceCase[] = [
  {
    name: "inherits requester thinking level when no spawn or subagent default is configured",
    task: "inherit thinking",
    requesterState: { thinkingLevel: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits requester fast mode for collector children",
    task: "inherit fast mode",
    requesterState: { fastMode: "auto" },
    preferenceKey: "fastMode",
    expected: "auto",
    swarmEnabled: true,
    collect: true,
    requesterRunId: "parent-run",
  },
  {
    name: "inherits requester fast mode for ordinary children when Swarm is enabled",
    task: "inherit ordinary fast mode",
    requesterState: { fastMode: true },
    preferenceKey: "fastMode",
    expected: true,
    swarmEnabled: true,
  },
  {
    name: "persists inherited requester thinking off",
    task: "inherit thinking off",
    requesterState: { thinkingLevel: "off" },
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "inherits requester agent thinkingDefault when the caller session has no stored thinking",
    task: "inherit agent thinking default",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "falls back to requester agent thinkingDefault when caller session store cannot be read",
    task: "inherit agent thinking default without session store",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    sessionStoreUnavailable: true,
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits global thinkingDefault when caller session and agent have no stored thinking",
    task: "inherit global thinking default",
    requesterState: {},
    agentDefaults: { thinkingDefault: "medium" },
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
  {
    name: "applies requester-agent subagent thinking before caller session thinking",
    task: "requester policy thinking",
    requesterState: { thinkingLevel: "high" },
    requesterAgent: { subagents: { thinking: "medium" } },
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
];

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
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
      quarantineFailedSubagentSpawnMock: hoisted.quarantineFailedSubagentSpawnMock,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
      hasSubagentRunIdentity: hoisted.hasSubagentRunIdentityMock,
      getLatestSubagentRunByChildSessionKey: hoisted.getLatestSubagentRunByChildSessionKeyMock,
      listSwarmRunsForGroup: hoisted.listSwarmRunsForGroupMock,
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.4",
      resolveSandboxRuntimeStatus: () => ({ sandboxed: false }),
      hookRunner: {
        hasHooks: (name: string) => Boolean(hoisted.hookRunner?.hasHooks?.(name)),
        runSubagentProgress: async (...args: unknown[]) => {
          await hoisted.hookRunner?.runSubagentProgress?.(...args);
        },
        runSubagentSpawned: async (...args: unknown[]) => {
          await hoisted.hookRunner?.runSubagentSpawned?.(...args);
        },
        runSubagentEnded: async (...args: unknown[]) => {
          await hoisted.hookRunner?.runSubagentEnded?.(...args);
        },
      },
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
    ({ activateCollectorLaunch } = await import("./subagent-collector-launch-failure.js"));
    ({ retryRetainedContextEnginePreparationRollback } =
      await import("./subagent-spawn-context.js"));
    ({ reserveSwarmRun } = await import("./swarm-scheduler.js"));
    spawnFailureQuarantine = await import("./subagent-spawn-failure-quarantine.js");
  });

  beforeEach(() => {
    swarmSchedulerTesting.reset();
    spawnFailureQuarantine.resetRetainedFailedSpawnAdmissionsForTests();
    resetSubagentSpawnAdmissionForTests();
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.loadPreparedModelCatalogMock.mockReset().mockResolvedValue([]);
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.quarantineFailedSubagentSpawnMock.mockReset();
    hoisted.startQueuedSubagentRunMock.mockReset().mockReturnValue(true);
    hoisted.settleFailedQueuedSubagentLaunchMock.mockReset().mockReturnValue(true);
    hoisted.completeCollectorLaunchCleanupMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.dispatchGatewayMethodInProcessMock.mockReset();
    hoisted.hasInProcessGatewayContextMock.mockReset().mockReturnValue(false);
    hoisted.resolveAgentConfigMock.mockReset();
    hoisted.resolveContextEngineMock.mockReset().mockResolvedValue({});
    hoisted.countActiveRunsForSessionMock.mockReset().mockReturnValue(0);
    hoisted.hasSubagentRunIdentityMock.mockReset().mockReturnValue(false);
    hoisted.getLatestSubagentRunByChildSessionKeyMock.mockReset().mockReturnValue(null);
    hoisted.listSwarmRunsForGroupMock.mockReset().mockReturnValue([]);
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    hoisted.configOverride = createConfigOverride();
    hoisted.hookRunner = null;
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    const sessionStore: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockReturnValue(sessionStore);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        await mutator(sessionStore);
        return sessionStore;
      },
    );
  });

  afterEach(() => {
    spawnFailureQuarantine.resetRetainedFailedSpawnAdmissionsForTests();
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("rejects direct swarm parameters while tools.swarm is disabled", async () => {
    const result = await spawnSubagentDirect(
      { task: "collect", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("tools.swarm.enabled=true"),
    });
    expect(gatewayRequestRecords()).toEqual([]);
  });

  it("requires a requesting run id when a collector omits groupId", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawnSubagentDirect(
      { task: "missing default group identity", collect: true },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("requesting run id"),
    });
  });

  it.each([{ mode: "session" as const }, { thread: true }])(
    "rejects interactive collector mode at the direct spawn boundary",
    async (params) => {
      hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

      const result = await spawnSubagentDirect(
        { task: "collect once", collect: true, ...params },
        { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
      );

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("mode=run and thread=false"),
      });
      expect(gatewayRequestRecords()).toEqual([]);
    },
  );

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn myself explicitly",
        agentId: "task-manager",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("keeps reserved target authorization inside the configured allowlist", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"] },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: { allowAgents: ["planner"] },
          },
          { id: "planner", workspace: "/tmp/workspace-planner" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "must respect configured allowlist",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:reserved-disallowed-worker",
        preallocatedRunId: "reserved-disallowed-worker-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-disallowed-worker-claim",
      },
    );

    expect(result.status).not.toBe("accepted");
    expect(result.error).toContain("not allowed");
    expect(gatewayRequestRecords()).toEqual([]);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reserved then reserved",
      first: spawnReservedWorker,
      second: spawnReservedWorker,
    },
    {
      name: "ordinary then reserved",
      first: spawnOrdinaryWorker,
      second: spawnReservedWorker,
    },
    {
      name: "reserved then ordinary",
      first: spawnReservedWorker,
      second: spawnOrdinaryWorker,
    },
  ])(
    "shares requester admission across mixed concurrent spawns: $name",
    async ({ first, second }) => {
      hoisted.configOverride = createConfigOverride({
        agents: {
          defaults: {
            workspace: os.tmpdir(),
            subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
          },
          list: [
            { id: "main", workspace: "/tmp/workspace-main" },
            { id: "worker", workspace: "/tmp/workspace-worker" },
          ],
        },
      });
      installActiveCountFromRegisteredRuns();
      hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
      const firstAgentStarted = deferred<void>();
      const releaseFirstAgent = deferred<Record<string, unknown>>();
      let agentCalls = 0;
      hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
        if (method.startsWith("sessions.")) {
          return { ok: true };
        }
        if (method === "agent") {
          agentCalls += 1;
          if (agentCalls === 1) {
            firstAgentStarted.resolve();
            return await releaseFirstAgent.promise;
          }
          return { runId: `unexpected-run-${agentCalls}` };
        }
        return {};
      });

      const firstSpawn = first("shared-admission-first");
      await firstAgentStarted.promise;

      const secondResult = await second("shared-admission-second");
      expect(secondResult.status).toBe("forbidden");
      expect(secondResult.error).toContain("max active children");
      expect(agentCalls).toBe(1);

      releaseFirstAgent.resolve({ runId: "shared-admission-first-run" });
      await expect(firstSpawn).resolves.toMatchObject({ status: "accepted" });
    },
  );

  it("admits one of at least three contenders and fails the rest closed", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const firstAgentStarted = deferred<void>();
    const releaseFirstAgent = deferred<Record<string, unknown>>();
    let agentCalls = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        agentCalls += 1;
        firstAgentStarted.resolve();
        return await releaseFirstAgent.promise;
      }
      return {};
    });

    const firstSpawn = spawnOrdinaryWorker("three-contenders-first");
    await firstAgentStarted.promise;
    const [secondResult, thirdResult] = await Promise.all([
      spawnReservedWorker("three-contenders-second"),
      spawnOrdinaryWorker("three-contenders-third"),
    ]);

    expect(secondResult.status).toBe("forbidden");
    expect(thirdResult.status).toBe("forbidden");
    expect(agentCalls).toBe(1);
    releaseFirstAgent.resolve({ runId: "three-contenders-first-run" });
    await expect(firstSpawn).resolves.toMatchObject({ status: "accepted" });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not double count a child after provisional admission hands off to registration", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 2 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    const spawnedHookEntered = deferred<void>();
    const releaseSpawnedHook = deferred<void>();
    let spawnedHookCalls = 0;
    hoisted.hookRunner = {
      hasHooks: (name) => name === "subagent_spawned",
      runSubagentSpawned: async () => {
        spawnedHookCalls += 1;
        if (spawnedHookCalls === 1) {
          spawnedHookEntered.resolve();
          await releaseSpawnedHook.promise;
        }
      },
    };

    const firstSpawn = spawnOrdinaryWorker("handoff-first");
    await spawnedHookEntered.promise;
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);

    const secondResult = await spawnOrdinaryWorker("handoff-second");
    expect(secondResult.status).toBe("accepted");
    releaseSpawnedHook.resolve();
    await expect(firstSpawn).resolves.toMatchObject({ status: "accepted" });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(2);
  });

  it("isolates shared admission capacity by requester session", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const firstAgentStarted = deferred<void>();
    const releaseFirstAgent = deferred<Record<string, unknown>>();
    let agentCalls = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        agentCalls += 1;
        if (agentCalls === 1) {
          firstAgentStarted.resolve();
          return await releaseFirstAgent.promise;
        }
        return { runId: "cross-requester-second-run" };
      }
      return {};
    });

    const firstSpawn = spawnOrdinaryWorker("cross-requester-first", "agent:main:main");
    await firstAgentStarted.promise;
    const secondResult = await spawnReservedWorker("cross-requester-second", "agent:main:other");

    expect(secondResult.status).toBe("accepted");
    expect(agentCalls).toBe(2);
    releaseFirstAgent.resolve({ runId: "cross-requester-first-run" });
    await expect(firstSpawn).resolves.toMatchObject({ status: "accepted" });
  });

  it("releases provisional admission after deterministic pre-dispatch failure", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.resolveContextEngineMock.mockRejectedValueOnce(new Error("context unavailable"));

    const firstResult = await spawnOrdinaryWorker("deterministic-failure-first");
    expect(firstResult.status).toBe("error");

    const secondResult = await spawnOrdinaryWorker("deterministic-failure-second");
    expect(secondResult.status).toBe("accepted");
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("quarantines exhausted indeterminate cleanup so the requester remains at capacity", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    const quarantineRows: Record<string, unknown>[] = [];
    installActiveCountFromRegisteredRuns(quarantineRows);
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation((row: Record<string, unknown>) => {
      quarantineRows.push(row);
      return "recorded";
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "sessions.delete") {
        throw new Error("session deletion did not settle");
      }
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        throw new Error("ambiguous dispatch failure");
      }
      return {};
    });

    const firstResult = await spawnReservedWorker("quarantined-failure");
    expect(firstResult).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });
    expect(hoisted.quarantineFailedSubagentSpawnMock).toHaveBeenCalledTimes(1);

    const secondResult = await spawnOrdinaryWorker("after-quarantined-failure");
    expect(secondResult.status).toBe("forbidden");
    expect(secondResult.error).toContain("max active children");
  });

  it("retains requester admission until deletion proof when quarantine persistence fails", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation(() => {
      throw new Error("registry persistence unavailable");
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const holderDeleteStarted = deferred<void>();
    const holderDelete = deferred<Record<string, unknown>>();
    let deleteCalls = 0;
    let failAgentLaunch = true;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "sessions.delete") {
        deleteCalls += 1;
        if (deleteCalls <= 3) {
          throw new Error("session deletion did not settle");
        }
        holderDeleteStarted.resolve();
        return await holderDelete.promise;
      }
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        if (failAgentLaunch) {
          throw new Error("ambiguous dispatch failure");
        }
        return { runId: "after-deletion-proof-run" };
      }
      return {};
    });

    const firstResult = await spawnReservedWorker("quarantine-persist-fails");
    expect(firstResult).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });
    expect(hoisted.quarantineFailedSubagentSpawnMock).toHaveBeenCalledTimes(1);

    const blockedResult = await spawnOrdinaryWorker("while-proof-missing");
    expect(blockedResult.status).toBe("forbidden");
    expect(blockedResult.error).toContain("max active children");

    const reconciliation = spawnFailureQuarantine.reconcileRetainedFailedSpawnAdmissionsForTests();
    await holderDeleteStarted.promise;
    const stillBlockedResult = await spawnOrdinaryWorker("while-proof-pending");
    expect(stillBlockedResult.status).toBe("forbidden");
    expect(stillBlockedResult.error).toContain("max active children");

    failAgentLaunch = false;
    holderDelete.resolve({ ok: true });
    await reconciliation;

    const admittedResult = await spawnOrdinaryWorker("after-deletion-proof");
    expect(admittedResult.status).toBe("accepted");
    expect(deleteCalls).toBe(4);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("bounds retained failed-spawn deletion retries without releasing admission", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation(() => {
      throw new Error("registry persistence unavailable");
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    let deleteCalls = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "sessions.delete") {
        deleteCalls += 1;
        throw new Error("session deletion did not settle");
      }
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        throw new Error("ambiguous dispatch failure");
      }
      return {};
    });

    const firstResult = await spawnReservedWorker("quarantine-persist-delete-outage");
    expect(firstResult).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });
    expect(hoisted.quarantineFailedSubagentSpawnMock).toHaveBeenCalledTimes(1);
    const provisionalCleanupAttempts = deleteCalls;

    const blockedResult = await spawnOrdinaryWorker("while-retained-proof-missing");
    expect(blockedResult.status).toBe("forbidden");
    expect(blockedResult.error).toContain("max active children");

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await spawnFailureQuarantine.reconcileRetainedFailedSpawnAdmissionsForTests();
    }

    expect(deleteCalls - provisionalCleanupAttempts).toBe(30);
    expect(spawnFailureQuarantine.inspectRetainedFailedSpawnAdmissions()).toEqual([
      expect.objectContaining({
        childSessionKey: "agent:worker:subagent:quarantine-persist-delete-outage",
        attempts: 30,
        maxAttempts: 30,
        status: "exhausted",
        retryScheduled: false,
      }),
    ]);

    await spawnFailureQuarantine.reconcileRetainedFailedSpawnAdmissionsForTests();
    expect(deleteCalls - provisionalCleanupAttempts).toBe(30);
    const stillBlockedResult = await spawnOrdinaryWorker("after-retained-retries-exhaust");
    expect(stillBlockedResult.status).toBe("forbidden");
    expect(stillBlockedResult.error).toContain("max active children");
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("keeps retained admission active when replacement inspection throws", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation(() => {
      throw new Error("registry persistence unavailable");
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const childSessionKey = "agent:worker:subagent:quarantine-persist-inspection-throws";
    const sessionIdentity = {
      expectedSessionId: "retained-inspection-original",
      expectedLifecycleRevision: "retained-inspection-lifecycle",
    };
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      const child = store[childSessionKey];
      if (child) {
        child.sessionId ??= sessionIdentity.expectedSessionId;
        child.lifecycleRevision ??= sessionIdentity.expectedLifecycleRevision;
      }
      return store;
    });
    let deleteCalls = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "sessions.delete") {
        deleteCalls += 1;
        throw new Error("session deletion did not settle");
      }
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        throw new Error("ambiguous dispatch failure");
      }
      return {};
    });

    const firstResult = await spawnReservedWorker("quarantine-persist-inspection-throws");
    expect(firstResult).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate", sessionIdentity },
    });
    const provisionalCleanupAttempts = deleteCalls;

    hoisted.loadSessionStoreMock.mockImplementation(() => {
      throw new Error("session store unavailable");
    });
    await spawnFailureQuarantine.reconcileRetainedFailedSpawnAdmissionsForTests();

    expect(deleteCalls - provisionalCleanupAttempts).toBe(1);
    const retained = spawnFailureQuarantine.inspectRetainedFailedSpawnAdmissions();
    expect(retained).toEqual([
      expect.objectContaining({
        childSessionKey,
        attempts: 1,
        status: "retrying",
        retryScheduled: true,
      }),
    ]);
    const deleteParams = hoisted.dispatchGatewayMethodInProcessMock.mock.calls
      .filter(([method]) => method === "sessions.delete")
      .map(([, params]) => requireRecord(params));
    expect(deleteParams).toContainEqual(expect.objectContaining(sessionIdentity));

    const blockedResult = await spawnOrdinaryWorker("after-retained-inspection-error");
    expect(blockedResult.status).toBe("forbidden");
    expect(blockedResult.error).toContain("max active children");
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("releases retained admission when a replacement child identity proves the original is gone", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation(() => {
      throw new Error("registry persistence unavailable");
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const childSessionKey = "agent:worker:subagent:quarantine-persist-replaced-child";
    const sessionIdentity = {
      expectedSessionId: "retained-original-session",
      expectedLifecycleRevision: "retained-original-lifecycle",
    };
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      const child = store[childSessionKey];
      if (child) {
        child.sessionId ??= sessionIdentity.expectedSessionId;
        child.lifecycleRevision ??= sessionIdentity.expectedLifecycleRevision;
      }
      return store;
    });
    let failAgentLaunch = true;
    let deleteCalls = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "sessions.delete") {
        deleteCalls += 1;
        throw new Error("session deletion did not settle");
      }
      if (method.startsWith("sessions.")) {
        return { ok: true };
      }
      if (method === "agent") {
        if (failAgentLaunch) {
          throw new Error("ambiguous dispatch failure");
        }
        return { runId: "after-replacement-proof-run" };
      }
      return {};
    });

    const firstResult = await spawnReservedWorker("quarantine-persist-replaced-child");
    expect(firstResult).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate", sessionIdentity },
    });
    expect(hoisted.quarantineFailedSubagentSpawnMock).toHaveBeenCalledTimes(1);

    const blockedResult = await spawnOrdinaryWorker("while-replacement-proof-missing");
    expect(blockedResult.status).toBe("forbidden");
    expect(blockedResult.error).toContain("max active children");

    store[childSessionKey] = {
      ...store[childSessionKey],
      sessionId: "retained-replacement-session",
      lifecycleRevision: "retained-replacement-lifecycle",
      updatedAt: Date.now(),
      status: "running",
    };

    await spawnFailureQuarantine.reconcileRetainedFailedSpawnAdmissionsForTests();
    expect(spawnFailureQuarantine.inspectRetainedFailedSpawnAdmissions()).toEqual([]);

    failAgentLaunch = false;
    const admittedResult = await spawnOrdinaryWorker("after-replacement-proof");
    expect(admittedResult.status).toBe("accepted");
    expect(deleteCalls).toBe(4);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("ignores caller-supplied provisional-count fields outside the shared admission owner", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();

    const result = await spawnSubagentDirect(
      {
        task: "ordinary caller cannot forge provisional capacity",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        reservedSubagentAdditionalActiveChildren: 99,
      } as Parameters<typeof spawnSubagentDirect>[1] & {
        reservedSubagentAdditionalActiveChildren: number;
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("allows omitted agentId to default to requester even when allowAgents excludes requester", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "task-manager",
            workspace: "/tmp/workspace-task-manager",
            subagents: {
              allowAgents: ["planner"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn default target",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:task-manager:subagent:/);
  });

  it("consumes plugin-reserved identities with exact one-shot target authorization", async () => {
    const preallocatedChildSessionKey = "agent:worker:subagent:plugin-reserved-child";
    const preallocatedRunId = "plugin-reserved-run";
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: {
              allowAgents: ["worker"],
            },
          },
          {
            id: "planner",
            workspace: "/tmp/workspace-planner",
          },
          {
            id: "worker",
            workspace: "/tmp/workspace-worker",
          },
        ],
      },
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) =>
        method === "agent" ? { runId: params.idempotencyKey } : { ok: true },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        const preallocatedChildEntry = store[preallocatedChildSessionKey];
        if (!preallocatedChildEntry) {
          throw new Error("expected preallocated child session entry");
        }
        preallocatedChildEntry.sessionId ??= "plugin-reserved-created-session";
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "launch through the plugin reservation",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey,
        preallocatedRunId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "requester-session",
        reservedSubagentClaimToken: "plugin-reserved-claim",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey: preallocatedChildSessionKey,
      runId: preallocatedRunId,
    });
    expect(firstRegisteredSubagentRun()).toMatchObject({
      childSessionKey: preallocatedChildSessionKey,
      runId: preallocatedRunId,
      agentId: "worker",
      expectsCompletionMessage: false,
    });
    const reservedDispatch = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.find(
      ([method]) => method === "agent",
    );
    const expectedSessionId = persistedStore?.[preallocatedChildSessionKey]?.sessionId;
    expect(expectedSessionId).toBeTypeOf("string");
    expect(reservedDispatch?.[1]).toMatchObject({
      sessionKey: preallocatedChildSessionKey,
      idempotencyKey: preallocatedRunId,
      expectedExistingSessionId: expectedSessionId,
    });
    expect(readReservedSubagentClaimToken(reservedDispatch?.[1])).toBe("plugin-reserved-claim");
    expect(reservedDispatch?.[2]).toMatchObject({ pluginRuntimeOwnerId: "agentic-os" });
    expect(persistedStore?.[preallocatedChildSessionKey]).toMatchObject({
      pluginOwnerId: "agentic-os",
      spawnedBy: "agent:main:main",
      pluginExtensions: {
        "agentic-os": {
          openclawReservedSubagent: {
            runId: preallocatedRunId,
            requesterSessionId: "requester-session",
            claimToken: "plugin-reserved-claim",
          },
        },
      },
    });
  });

  it("replays an exact plugin-reserved provisional child row after a crash", async () => {
    const childSessionKey = "agent:worker:subagent:reserved-crash-replay-child";
    const runId = "reserved-crash-replay-run";
    const claimToken = "reserved-crash-replay-fingerprint";
    const existingEntry = {
      sessionId: "reserved-crash-replay-session",
      createdAt: 1,
      updatedAt: 1,
      pluginOwnerId: "agentic-os",
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      model: "stale-model",
      modelProvider: "stale-provider",
      modelOverride: "stale-model",
      providerOverride: "stale-provider",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      modelOverrideFallbackOriginProvider: "stale-provider",
      modelOverrideFallbackOriginModel: "stale-model",
      pluginExtensions: {
        "agentic-os": {
          openclawReservedSubagent: {
            runId,
            requesterSessionId: "requester-session",
            claimToken,
          },
        },
      },
    };
    const store: Record<string, Record<string, unknown>> = {
      [childSessionKey]: { ...existingEntry },
    };
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], model: "openai/gpt-5.4" },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) =>
        method === "agent" ? { runId: params.idempotencyKey } : { ok: true },
    );

    const result = await spawnSubagentDirect(
      {
        task: "resume the exact reserved child after a crash",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "requester-session",
        reservedSubagentClaimToken: claimToken,
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      childSessionKey,
      runId,
    });
    expect(store[childSessionKey]).toMatchObject({
      ...existingEntry,
      pluginExtensions: existingEntry.pluginExtensions,
      model: "gpt-5.4",
      modelProvider: "openai",
      modelOverride: "gpt-5.4",
      providerOverride: "openai",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.4",
    });
    expect(
      hoisted.dispatchGatewayMethodInProcessMock.mock.calls.filter(
        ([method]) => method === "agent",
      ),
    ).toHaveLength(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("rejects exact plugin-reserved identities once durable registry state exists", async () => {
    const childSessionKey = "agent:worker:subagent:reserved-registry-replay-child";
    const runId = "reserved-registry-replay-run";
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.hasSubagentRunIdentityMock.mockImplementation(
      (candidate: string) => candidate === runId,
    );
    hoisted.getLatestSubagentRunByChildSessionKeyMock.mockImplementation((candidate: string) =>
      candidate === childSessionKey ? { runId, childSessionKey } : null,
    );

    const result = await spawnSubagentDirect(
      {
        task: "registry state makes exact replay fail closed",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "requester-session",
        reservedSubagentClaimToken: "reserved-registry-replay-claim",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("durable registry state"),
      childSessionKey,
      runId,
    });
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("rejects an altered plugin-reserved crash replay without mutation or dispatch", async () => {
    const childSessionKey = "agent:worker:subagent:reserved-crash-replay-altered-child";
    const runId = "reserved-crash-replay-altered-run";
    const existingEntry = {
      sessionId: "reserved-crash-replay-altered-session",
      createdAt: 1,
      updatedAt: 1,
      pluginOwnerId: "agentic-os",
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      pluginExtensions: {
        "agentic-os": {
          openclawReservedSubagent: {
            runId,
            requesterSessionId: "requester-session",
            claimToken: "reserved-crash-replay-original-fingerprint",
          },
        },
      },
    };
    const store: Record<string, Record<string, unknown>> = {
      [childSessionKey]: { ...existingEntry },
    };
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);

    const result = await spawnSubagentDirect(
      {
        task: "altered replay must fail closed",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "requester-session",
        reservedSubagentClaimToken: "reserved-crash-replay-changed-fingerprint",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("reserved childSessionKey already exists"),
      childSessionKey,
    });
    expect(store[childSessionKey]).toEqual(existingEntry);
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("rejects a plugin-reserved replay from the same key after requester recreation", async () => {
    const childSessionKey = "agent:worker:subagent:reserved-recreated-requester-child";
    const runId = "reserved-recreated-requester-run";
    const claimToken = "reserved-recreated-requester-fingerprint";
    const existingEntry = {
      sessionId: "reserved-recreated-requester-child-session",
      createdAt: 1,
      updatedAt: 1,
      pluginOwnerId: "agentic-os",
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      pluginExtensions: {
        "agentic-os": {
          openclawReservedSubagent: {
            runId,
            requesterSessionId: "original-requester-session",
            claimToken,
          },
        },
      },
    };
    const store: Record<string, Record<string, unknown>> = {
      [childSessionKey]: { ...existingEntry },
    };
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);

    const result = await spawnSubagentDirect(
      {
        task: "same key and task must not reclaim after requester recreation",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: "agentic-os",
        requesterSessionId: "replacement-requester-session",
        reservedSubagentClaimToken: claimToken,
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("reserved childSessionKey already exists"),
      childSessionKey,
    });
    expect(store[childSessionKey]).toEqual(existingEntry);
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("rejects an existing reserved child session without mutating or dispatching it", async () => {
    const childSessionKey = "agent:worker:subagent:existing-reserved-child";
    const existingEntry = {
      sessionId: "existing-session",
      updatedAt: 1,
      pluginOwnerId: "other-plugin",
      spawnedBy: "agent:other:main",
    };
    const store: Record<string, Record<string, unknown>> = {
      [childSessionKey]: { ...existingEntry },
    };
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });

    const result = await spawnSubagentDirect(
      {
        task: "must not overwrite the existing child",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: "reserved-run-existing-child",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-existing-child-claim",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("reserved childSessionKey already exists"),
      childSessionKey,
    });
    expect(store[childSessionKey]).toEqual(existingEntry);
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("atomically accepts only one concurrent creator for a reserved child session", async () => {
    const childSessionKey = "agent:worker:subagent:concurrent-reserved-child";
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(
      async (method: string, params: Record<string, unknown>) =>
        method === "agent" ? { runId: params.idempotencyKey } : { ok: true },
    );
    const spawn = () =>
      spawnSubagentDirect(
        {
          task: "claim the child exactly once",
          agentId: "worker",
          expectsCompletionMessage: false,
        },
        {
          agentSessionKey: "agent:main:main",
          authorizedTargetAgentId: "worker",
          preallocatedChildSessionKey: childSessionKey,
          preallocatedRunId: "reserved-run-concurrent-child",
          pluginOwnerId: "agentic-os",
          reservedSubagentClaimToken: "reserved-concurrent-child-claim",
        },
      );

    const results = await Promise.all([spawn(), spawn()]);

    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "error" &&
          result.error?.includes("reserved childSessionKey already exists"),
      ),
    ).toHaveLength(1);
    expect(
      hoisted.dispatchGatewayMethodInProcessMock.mock.calls.filter(
        ([method]) => method === "agent",
      ),
    ).toHaveLength(1);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "mismatched target",
      context: {
        authorizedTargetAgentId: "planner",
        preallocatedChildSessionKey: "agent:worker:subagent:reserved",
        preallocatedRunId: "reserved-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-target-mismatch-claim",
      },
      expected: "reserved spawn target does not match requested agentId",
    },
    {
      name: "mismatched child agent",
      context: {
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:planner:subagent:reserved",
        preallocatedRunId: "reserved-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-child-mismatch-claim",
      },
      expected: "reserved childSessionKey must be",
    },
    {
      name: "partial reservation",
      context: {
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:reserved",
      },
      expected: "reserved subagent spawn requires",
    },
    {
      name: "incognito child for durable requester",
      context: {
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:incognito-reserved",
        preallocatedRunId: "reserved-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-incognito-mismatch-claim",
      },
      expected: "matching incognito classification",
    },
    {
      name: "durable child for incognito requester",
      agentSessionKey: "agent:main:dashboard:incognito-parent",
      context: {
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:reserved",
        preallocatedRunId: "reserved-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-incognito-requester-mismatch-claim",
      },
      expected: "matching incognito classification",
    },
  ])("rejects an invalid plugin reservation: $name", async (testCase) => {
    const { context, expected } = testCase;
    const agentSessionKey =
      "agentSessionKey" in testCase ? testCase.agentSessionKey : "agent:main:main";
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "planner", workspace: "/tmp/workspace-planner" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      { task: "reject invalid reservation", agentId: "worker" },
      {
        agentSessionKey,
        ...context,
      },
    );

    expect(result.status).not.toBe("accepted");
    expect(result.error).toContain(expected);
    expect(gatewayRequestRecords()).toEqual([]);
  });

  it("inherits incognito storage ownership for direct children", async () => {
    const requesterSessionKey = "agent:main:dashboard:incognito-parent";
    const sessionPatches: Record<string, unknown>[] = [];
    const sessionStorePaths: string[] = [];
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        sessionStorePaths.push(storePath);
        await mutator(store);
        sessionPatches.push(...Object.values(store));
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      { task: "keep this child in memory" },
      { agentSessionKey: requesterSessionKey },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:incognito-/u);
    expect(sessionPatches).toContainEqual(expect.objectContaining({ incognito: true }));
    expect(sessionStorePaths).toContain(
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    );
  });

  it("defaults collector group id from requester session and requesting run", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    const sessionPatches: Record<string, unknown>[] = [];
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        await mutator(store);
        sessionPatches.push(...Object.values(store));
        return store;
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "collect evidence",
        collect: true,
        outputSchema: { type: "object", required: ["answer"] },
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "chat:123",
        agentThreadId: "456",
        requesterRunId: "parent-run",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.sessionKey).toBe(result.childSessionKey);
    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput).toMatchObject({
      runId: result.runId,
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
      groupId: "swarm:agent:main:main:parent-run",
      outputSchema: { type: "object", required: ["answer"] },
      progressOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "chat:123",
        threadId: "456",
      },
    });
    expect(sessionPatches).toContainEqual(
      expect.objectContaining({
        swarmGroupId: "swarm:agent:main:main:parent-run",
        swarmCollector: true,
        swarmOutputSchema: { type: "object", required: ["answer"] },
      }),
    );
    await vi.waitFor(() =>
      expect(gatewayRequest("agent")).toEqual(expect.objectContaining({ method: "agent" })),
    );
    expect(gatewayRequest("agent")).toMatchObject({
      params: {
        swarmCollector: true,
        swarmOutputSchema: { type: "object", required: ["answer"] },
      },
    });
    const agentParams = requireRecord(gatewayRequest("agent").params);
    expect(agentParams).not.toHaveProperty("channel");
    expect(agentParams).not.toHaveProperty("to");
    expect(agentParams).not.toHaveProperty("accountId");
    expect(agentParams).not.toHaveProperty("threadId");
    expect(agentParams.extraSystemPrompt).toContain("until one payload is accepted");
    expect(agentParams.extraSystemPrompt).toContain("at most one retry");
    await vi.waitFor(() =>
      expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(result.runId, "run-1"),
    );
  });

  it("persists a host-reserved collector launch identity", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawnSubagentDirect(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    const otherRequesterResult = await spawnSubagentDirect(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      },
      { agentSessionKey: "agent:main:other", requesterRunId: "parent-run" },
    );

    expect(result).toMatchObject({ status: "accepted" });
    expect(result.runId).toMatch(/^swarm_[0-9a-f]{32}$/u);
    expect(otherRequesterResult).toMatchObject({ status: "accepted" });
    expect(otherRequesterResult.runId).toMatch(/^swarm_[0-9a-f]{32}$/u);
    expect(otherRequesterResult.runId).not.toBe(result.runId);
    expect(firstRegisteredSubagentRun()).toMatchObject({
      runId: result.runId,
      swarmLaunchIdempotencyKey: result.runId,
      swarmLaunchReplayKey: "cm-restart:bridge:1",
      swarmLaunchRequestFingerprint: "sha256:request",
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(requireRecord(gatewayRequest("agent").params).idempotencyKey).toBe(result.runId);
  });

  it("carries explicit model authorization through a queued collector launch", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawnSubagentDirect(
      {
        task: "collect with the requested model",
        model: "openai/gpt-5.4",
        collect: true,
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result).toMatchObject({ status: "accepted", modelApplied: true });
    const queuedLaunch = requireRecord(firstRegisteredSubagentRun().queuedLaunch);
    const queuedRequest = requireRecord(queuedLaunch.request);
    expect(queuedRequest).not.toHaveProperty("provider");
    expect(queuedRequest).not.toHaveProperty("model");
    expect(queuedLaunch).toMatchObject({
      authorization: {
        modelOverride: { provider: "openai", model: "gpt-5.4" },
      },
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(gatewayRequest("agent")).toMatchObject({
      scopes: ["operator.admin"],
      params: { provider: "openai", model: "gpt-5.4" },
    });
  });

  it("aborts a collector cancelled while its gateway launch is in flight", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.startQueuedSubagentRunMock.mockReturnValue(false);

    const result = await spawnSubagentDirect(
      { task: "cancel during launch", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result.status).toBe("accepted");
    await vi.waitFor(() => expect(gatewayRequest("chat.abort")).toBeDefined());
    expect(gatewayRequest("chat.abort")).toMatchObject({
      params: { sessionKey: result.childSessionKey, runId: "run-1" },
    });
    await vi.waitFor(() =>
      expect(hoisted.completeCollectorLaunchCleanupMock).toHaveBeenCalledWith(result.runId),
    );
  });

  it("holds the collector slot until an accepted run is confirmed stopped", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    });
    hoisted.startQueuedSubagentRunMock.mockReturnValueOnce(false).mockReturnValue(true);
    let stopAllowed = false;
    let agentCalls = 0;
    let abortCalls = 0;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `gateway-${agentCalls}` };
      }
      if (request.method === "chat.abort") {
        abortCalls += 1;
        if (!stopAllowed) {
          throw new Error("abort unavailable");
        }
        return {};
      }
      if (request.method === "sessions.delete") {
        throw new Error("delete unavailable");
      }
      return {};
    });

    const first = await spawnSubagentDirect(
      { task: "stop-confirmation-first", collect: true, groupId: "stop-confirmation" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    const second = await spawnSubagentDirect(
      { task: "stop-confirmation-second", collect: true, groupId: "stop-confirmation" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    await vi.waitFor(() => expect(abortCalls).toBeGreaterThan(0));
    expect(agentCalls).toBe(1);
    stopAllowed = true;
    await vi.waitFor(() => expect(agentCalls).toBe(2));
    await vi.waitFor(() =>
      expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(second.runId, "gateway-2"),
    );
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledWith(
      first.runId,
      expect.any(String),
    );
  });

  it("holds the collector slot while an indeterminate launch session is deleted", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    });
    let agentCalls = 0;
    let releaseDelete: (() => void) | undefined;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          const message = String(requireRecord(request.params).message);
          if (
            !message.includes("indeterminate-first") &&
            !message.includes("indeterminate-second")
          ) {
            return { runId: "unrelated" };
          }
          agentCalls += 1;
          if (agentCalls === 1) {
            throw new Error("launch response lost");
          }
          return { runId: "gateway-second" };
        }
        if (request.method === "sessions.delete") {
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseDelete = () => resolve({});
          });
        }
        return {};
      },
    );

    await spawnSubagentDirect(
      { task: "indeterminate-first", collect: true, groupId: "indeterminate" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    await spawnSubagentDirect(
      { task: "indeterminate-second", collect: true, groupId: "indeterminate" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).not.toHaveBeenCalled();
    releaseDelete?.();
    await vi.waitFor(() => expect(agentCalls).toBe(2));
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledOnce();
  });

  it("emits collector deletion after an asynchronous launch failure", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      return {};
    });

    const result = await spawnSubagentDirect(
      { task: "fail launch", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result.status).toBe("accepted");
    await vi.waitFor(() =>
      expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
        sessionKey: result.childSessionKey,
        reason: "delete",
        parentSessionKey: "agent:main:main",
      }),
    );
  });

  it("keeps failed-launch cleanup pending when context rollback fails", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.resolveContextEngineMock.mockResolvedValue({
      prepareSubagentSpawn: async () => ({
        rollback: async () => {
          throw new Error("rollback unavailable");
        },
      }),
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      return {};
    });

    await spawnSubagentDirect(
      { task: "fail launch", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    await vi.waitFor(() =>
      expect(
        hoisted.callGatewayMock.mock.calls.some(
          ([request]) => (request as { method?: string }).method === "sessions.delete",
        ),
      ).toBe(true),
    );
    expect(hoisted.completeCollectorLaunchCleanupMock).not.toHaveBeenCalled();
  });

  it("retains the actual context preparation rollback for failed collector launch retry", async () => {
    let rollbackAttempts = 0;
    const preparation = {
      rollback: vi.fn(async () => {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) {
          throw new Error("transient rollback failure");
        }
      }),
    };

    activateFailingCollectorLaunchForTest({
      childRunId: "failed-collector-rollback-retry-run",
      childSessionKey: "agent:main:subagent:failed-collector-rollback-retry",
      contextEnginePreparation: preparation,
    });

    await vi.waitFor(() => {
      expect(preparation.rollback).toHaveBeenCalledTimes(1);
      expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledWith(
        "failed-collector-rollback-retry-run",
        expect.any(String),
        { contextEnginePreparationRollbackPending: true },
      );
    });
    await expect(
      retryRetainedContextEnginePreparationRollback("failed-collector-rollback-retry-run"),
    ).resolves.toBe("completed");
    expect(preparation.rollback).toHaveBeenCalledTimes(2);
  });

  it("bounds collector launch settlement retries when registry persistence keeps failing", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.useFakeTimers();
    hoisted.settleFailedQueuedSubagentLaunchMock.mockImplementation(() => {
      throw new Error("registry busy");
    });

    activateFailingCollectorLaunchForTest({
      childRunId: "failed-collector-settlement-run",
      childSessionKey: "agent:main:subagent:failed-collector-settlement",
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() =>
      expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledTimes(3),
    );
    expect(hoisted.completeCollectorLaunchCleanupMock).not.toHaveBeenCalled();
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:failed-collector-settlement",
        reason: "delete",
      }),
    );
    vi.useRealTimers();
  });

  it("uses and validates tools.swarm.defaultAgentId for collector children", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, defaultAgentId: "worker" } },
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: { allowAgents: ["worker"] },
          },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      { task: "collect as worker", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);

    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, defaultAgentId: "missing" } },
    });
    const rejected = await spawnSubagentDirect(
      { task: "collect as missing", collect: true },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    expect(rejected.status).toBe("forbidden");
    expect(rejected.error).toContain("tools.swarm.defaultAgentId");
  });

  it("rejects collector live and lifetime caps with config-key errors", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: {
        swarm: {
          enabled: true,
          maxChildrenPerGroup: 1,
          maxTotalPerGroup: 2,
        },
      },
    });
    hoisted.listSwarmRunsForGroupMock.mockReturnValueOnce([
      { runId: "live", collect: true, groupId: "group" },
    ]);
    const liveRejected = await spawnSubagentDirect(
      { task: "second live child", collect: true, groupId: "group" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    expect(liveRejected.status).toBe("forbidden");
    expect(liveRejected.error).toContain("tools.swarm.maxChildrenPerGroup");
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenLastCalledWith("group", "agent:main:main");

    hoisted.listSwarmRunsForGroupMock.mockReturnValueOnce([
      { runId: "done", collect: true, collectorCompletion: { status: "done" } },
      { runId: "failed", collect: true, collectorCompletion: { status: "failed" } },
    ]);
    const totalRejected = await spawnSubagentDirect(
      { task: "third lifetime child", collect: true, groupId: "group" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );
    expect(totalRejected.status).toBe("forbidden");
    expect(totalRejected.error).toContain("tools.swarm.maxTotalPerGroup");
  });

  it("keeps live collector caps independent across caller-supplied group ids", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxChildrenPerGroup: 1 } },
    });
    const accepted = await spawnSubagentDirect(
      { task: "new group", collect: true, groupId: "fresh" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(accepted.status).toBe("accepted");
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenCalledWith("fresh", "agent:main:main");
  });

  it("enforces group caps atomically across concurrent collector registration", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxChildrenPerGroup: 1 } },
    });
    hoisted.listSwarmRunsForGroupMock.mockImplementation(() =>
      hoisted.registerSubagentRunMock.mock.calls.map(([run]) => requireRecord(run)),
    );

    const results = await Promise.all([
      spawnSubagentDirect(
        { task: "first concurrent child", collect: true, groupId: "shared" },
        { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
      ),
      spawnSubagentDirect(
        { task: "second concurrent child", collect: true, groupId: "shared" },
        { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
      ),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["accepted", "forbidden"]);
    expect(results.find((result) => result.status === "forbidden")?.error).toContain(
      "tools.swarm.maxChildrenPerGroup",
    );
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("enforces ordinary child caps while accepted gateway dispatches are still pending", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 2 },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.countActiveRunsForSessionMock.mockImplementation(
      () => hoisted.registerSubagentRunMock.mock.calls.length,
    );
    let releasePendingDispatches!: () => void;
    const pendingDispatches = new Promise<void>((resolve) => {
      releasePendingDispatches = resolve;
    });
    let dispatchedRuns = 0;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent") {
        return request.method?.startsWith("sessions.") ? { ok: true } : {};
      }
      const runNumber = ++dispatchedRuns;
      if (runNumber <= 2) {
        await pendingDispatches;
      }
      return { runId: `run-${runNumber}` };
    });
    const controllerSessionKey = "agent:main:telegram:default:direct:456";
    const spawnContext = {
      agentSessionKey: controllerSessionKey,
      completionOwnerKey: "agent:main:main",
    };

    const first = spawnSubagentDirect({ task: "first pending child" }, spawnContext);
    const second = spawnSubagentDirect({ task: "second pending child" }, spawnContext);
    await vi.waitFor(() => expect(dispatchedRuns).toBe(2));
    const rejected = await spawnSubagentDirect({ task: "third over-cap child" }, spawnContext);
    releasePendingDispatches();
    const accepted = await Promise.all([first, second]);

    expect(rejected).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("max active children for this session (2/2"),
    });
    expect(accepted.map((result) => result.status)).toEqual(["accepted", "accepted"]);
    expect(dispatchedRuns).toBe(2);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(2);
    expect(hoisted.countActiveRunsForSessionMock).toHaveBeenCalledWith(controllerSessionKey, {
      collect: false,
    });
  });

  it("returns ordinary child capacity after gateway dispatch fails", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 1 },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    let dispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        if (++dispatchAttempts === 1) {
          throw new Error("gateway dispatch failed");
        }
        return { runId: "replacement-run" };
      }
      return request.method?.startsWith("sessions.") ? { ok: true } : {};
    });
    const context = { agentSessionKey: "agent:main:main" };

    const failed = await spawnSubagentDirect({ task: "failing child" }, context);
    const replacement = await spawnSubagentDirect({ task: "replacement child" }, context);

    expect(failed).toMatchObject({
      status: "error",
      error: expect.stringContaining("gateway dispatch failed"),
    });
    expect(replacement).toMatchObject({ status: "accepted", runId: "replacement-run" });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("shares pending child capacity between native and visible spawn paths", async () => {
    const { maybeSpawnVisibleSession } = await import("./tools/sessions-spawn-visible.js");
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 1 },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    let releaseNativeDispatch!: () => void;
    const pendingNativeDispatch = new Promise<void>((resolve) => {
      releaseNativeDispatch = resolve;
    });
    let nativeDispatchStarted = false;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        nativeDispatchStarted = true;
        await pendingNativeDispatch;
        return { runId: "native-run" };
      }
      return request.method?.startsWith("sessions.") ? { ok: true } : {};
    });
    const controllerSessionKey = "agent:main:telegram:default:direct:456";
    const native = spawnSubagentDirect(
      { task: "pending native child" },
      { agentSessionKey: controllerSessionKey, completionOwnerKey: "agent:main:main" },
    );
    await vi.waitFor(() => expect(nativeDispatchStarted).toBe(true));
    const visibleGateway = vi.fn();

    const rejected = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: "visible over-cap child",
      label: "",
      runtime: "subagent",
      sandbox: "inherit",
      options: {
        agentSessionKey: controllerSessionKey,
        completionOwnerKey: "agent:main:main",
        config: hoisted.configOverride as OpenClawConfig,
        callGateway: visibleGateway,
        countActiveRuns: hoisted.countActiveRunsForSessionMock,
      },
    });
    releaseNativeDispatch();
    const accepted = await native;

    expect(rejected).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("max active children for this session (1/1"),
    });
    expect(accepted).toMatchObject({ status: "accepted", runId: "native-run" });
    expect(visibleGateway).not.toHaveBeenCalled();
  });

  it("admits a sixth live collector under the swarm group cap", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxChildrenPerGroup: 6 } },
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 5 },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.countActiveRunsForSessionMock.mockReturnValue(5);
    hoisted.listSwarmRunsForGroupMock.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({
        runId: `collector-${index}`,
        collect: true,
        execution: { status: "running" },
      })),
    );

    const accepted = await spawnSubagentDirect(
      { task: "sixth collector", collect: true, groupId: "fresh" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(accepted.status).toBe("accepted");
    expect(hoisted.countActiveRunsForSessionMock).not.toHaveBeenCalled();
  });

  it("admits an announce child when 50 collectors are active", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 5 },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.countActiveRunsForSessionMock.mockImplementation(
      (_sessionKey: string, options?: { collect?: boolean }) =>
        options?.collect === false ? 0 : 50,
    );

    const accepted = await spawnSubagentDirect(
      { task: "announce independently" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(accepted.status).toBe("accepted");
    expect(hoisted.countActiveRunsForSessionMock).toHaveBeenCalledWith("agent:main:main", {
      collect: false,
    });
  });

  it("rejects invalid collector output schemas before creating a child session", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

    const rejected = await spawnSubagentDirect(
      {
        task: "invalid schema",
        collect: true,
        outputSchema: { type: "object", properties: "invalid" },
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("Invalid sessions_spawn outputSchema");
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("rejects schema collection for a model that cannot call tools", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([
      {
        provider: "openai",
        id: "no-tools",
        name: "No tools",
        compat: { supportsTools: false },
      },
    ]);

    const rejected = await spawnSubagentDirect(
      {
        task: "structured result",
        model: "openai/no-tools",
        collect: true,
        outputSchema: { type: "object" },
      },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("requires a tool-capable target model");
    expect(hoisted.loadPreparedModelCatalogMock).toHaveBeenCalledWith({
      config: hoisted.configOverride,
      agentDir: expect.any(String),
      workspaceDir: "/tmp/workspace-main",
    });
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("rejects a group id outside collector mode", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });

    const rejected = await spawnSubagentDirect(
      { task: "ordinary child", groupId: "swarm:custom" },
      { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
    );

    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("groupId requires collect=true");
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("registers the target agent id for cross-agent task attribution", async () => {
    hoisted.configOverride = createConfigOverride({
      session: {
        scope: "global",
      },
      agents: {
        defaults: {
          workspace: os.tmpdir(),
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            subagents: {
              allowAgents: ["worker"],
            },
          },
          {
            id: "worker",
            workspace: "/tmp/workspace-worker",
          },
        ],
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "attribute worker run",
        agentId: "worker",
      },
      {
        agentSessionKey: "global",
        requesterAgentIdOverride: "main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);
    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput.childSessionKey).toBe(result.childSessionKey);
    expect(registerInput.agentId).toBe("worker");
    expect(registerInput.requesterSessionKey).toBe("global");
    expect(registerInput.requesterAgentId).toBe("main");
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    let persistedStore: Record<string, Record<string, unknown>> | undefined;

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe("run-1");
    expect(result.mode).toBe("run");
    expect(result.modelApplied).toBe(true);
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expect(persistedStore?.[childSessionKey]).toMatchObject({
      spawnedBy: "agent:main:main",
      completionOwnerSessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: expect.any(Number),
    });
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(registerInput.runId).toBe("run-1");
    expect(registerInput.childSessionKey).toBe(childSessionKey);
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin.threadId).toBe(42);
    expect(registerInput.task).toBe("inspect the spawn seam");
    expect(registerInput.cleanup).toBe("keep");
    expect(registerInput.model).toBe("openai/gpt-5.4");
    expect(registerInput.workspaceDir).toBe("/tmp/requester-workspace");
    expect(registerInput.expectsCompletionMessage).toBe(true);
    expect(registerInput.spawnMode).toBe("run");
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: childSessionKey,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentRequest.scopes).toEqual(["operator.admin"]);
    expect(agentParams.sessionKey).toBe(childSessionKey);
    expect(agentParams.provider).toBe("openai");
    expect(agentParams.model).toBe("gpt-5.4");
    expect(agentParams.cleanupBundleMcpOnRunEnd).toBe(true);
  });

  it("dispatches spawned agent runs in process when a gateway context is available", async () => {
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.callGatewayMock.mockRejectedValue(new Error("unexpected websocket gateway call"));
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        return { runId: "run-in-process" };
      }
      return { ok: true };
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn without websocket self-connection",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.runId).toBe("run-in-process");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.dispatchGatewayMethodInProcessMock).toHaveBeenCalledWith(
      "agent",
      expect.objectContaining({
        message: expect.stringContaining("spawn without websocket self-connection"),
        sessionKey: result.childSessionKey,
      }),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    const agentDispatch = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.find(
      ([method]) => method === "agent",
    );
    const agentParams = requireRecord(agentDispatch?.[1]);
    const agentOptions = requireRecord(agentDispatch?.[2]);
    expect(agentParams.provider).toBeUndefined();
    expect(agentParams.model).toBeUndefined();
    expect(agentOptions.allowSyntheticModelOverride).toBeUndefined();
  });

  it("authorizes explicit model overrides for in-process child launches", async () => {
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.callGatewayMock.mockRejectedValue(new Error("unexpected websocket gateway call"));
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      return method === "agent" ? { runId: "run-in-process-model" } : { ok: true };
    });

    const result = await spawnSubagentDirect(
      { task: "spawn on the requested model", model: "openai/gpt-5.4" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({ status: "accepted", runId: "run-in-process-model" });
    const agentDispatch = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.find(
      ([method]) => method === "agent",
    );
    expect(agentDispatch?.[1]).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    expect(agentDispatch?.[2]).toMatchObject({
      allowSyntheticModelOverride: true,
      forceSyntheticClient: true,
    });
  });

  it("keeps admin-scoped cleanup on in-process spawn failure", async () => {
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.callGatewayMock.mockRejectedValue(new Error("unexpected websocket gateway call"));
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("spawn failed");
      }
      return { ok: true };
    });

    const result = await spawnSubagentDirect(
      {
        task: "spawn failure cleanup",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("spawn failed");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.dispatchGatewayMethodInProcessMock).toHaveBeenCalledWith(
      "sessions.delete",
      expect.objectContaining({
        key: result.childSessionKey,
        deleteTranscript: true,
      }),
      expect.objectContaining({
        forceSyntheticClient: true,
        syntheticScopes: ["operator.admin"],
      }),
    );
  });

  it("returns reserved cleanup indeterminate after bounded in-process deletion failures", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    const sessionIdentity = {
      expectedSessionId: "ambiguous-reserved-child-session",
      expectedLifecycleRevision: "ambiguous-reserved-child-lifecycle",
    };
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      const child = store["agent:worker:subagent:ambiguous-reserved-child"];
      if (child) {
        child.sessionId ??= sessionIdentity.expectedSessionId;
        child.lifecycleRevision ??= sessionIdentity.expectedLifecycleRevision;
      }
      return store;
    });
    let deleteAttempts = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        throw new Error("cleanup unavailable");
      }
      return { ok: true };
    });

    const result = await spawnSubagentDirect(
      {
        task: "retain the reserved identities during ambiguous cleanup",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:ambiguous-reserved-child",
        preallocatedRunId: "ambiguous-reserved-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "ambiguous-reserved-claim",
      },
    );
    expect(result).toMatchObject({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: "agent:worker:subagent:ambiguous-reserved-child",
      runId: "ambiguous-reserved-run",
      reservedCleanup: {
        sessionDeletion: "indeterminate",
        sessionIdentity,
      },
    });
    const capturedSessionIdentity = requireRecord(
      requireRecord(result.reservedCleanup).sessionIdentity,
    );
    expect(hoisted.quarantineFailedSubagentSpawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdentity: capturedSessionIdentity }),
    );
    const sessionDeleteCalls = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.filter(
      ([method]) => method === "sessions.delete",
    );
    expect(sessionDeleteCalls.map(([, params]) => params)).toEqual([
      expect.objectContaining(capturedSessionIdentity),
      expect.objectContaining(capturedSessionIdentity),
      expect.objectContaining(capturedSessionIdentity),
    ]);
    expect(deleteAttempts).toBe(3);
  });

  it("cleans up an accepted reserved launch cancelled before registry registration", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { allowAgents: ["worker"], maxChildrenPerAgent: 1 },
        },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    installActiveCountFromRegisteredRuns();
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.quarantineFailedSubagentSpawnMock.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    const abortController = new AbortController();
    const childSessionKey = "agent:worker:subagent:accepted-then-cancelled-child";
    const runId = "accepted-then-cancelled-reserved-run";
    const acceptedGatewayRunId = "accepted-then-cancelled-gateway-run";
    const sessionIdentity = {
      expectedSessionId: "accepted-then-cancelled-session",
      expectedLifecycleRevision: "accepted-then-cancelled-lifecycle",
    };
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      const child = store[childSessionKey];
      if (child) {
        child.sessionId = sessionIdentity.expectedSessionId;
        child.lifecycleRevision = sessionIdentity.expectedLifecycleRevision;
      }
      return store;
    });
    let deleteAttempts = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        abortController.abort(new Error("requester cancelled after accepted launch"));
        return { runId: acceptedGatewayRunId };
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        throw new Error("cleanup unavailable");
      }
      return { ok: true };
    });

    const result = await spawnSubagentDirect(
      {
        task: "cancel after the reserved child launch is accepted",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "accepted-then-cancelled-claim",
        signal: abortController.signal,
      },
    );

    expect(result).toMatchObject({
      status: "error",
      error: "requester cancelled after accepted launch",
      childSessionKey,
      runId: acceptedGatewayRunId,
      reservedCleanup: {
        sessionDeletion: "indeterminate",
        sessionIdentity,
      },
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
    const capturedSessionIdentity = requireRecord(
      requireRecord(result.reservedCleanup).sessionIdentity,
    );
    const sessionDeleteCalls = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.filter(
      ([method]) => method === "sessions.delete",
    );
    expect(sessionDeleteCalls.map(([, params]) => params)).toEqual([
      expect.objectContaining(capturedSessionIdentity),
      expect.objectContaining(capturedSessionIdentity),
      expect.objectContaining(capturedSessionIdentity),
    ]);
    expect(deleteAttempts).toBe(3);
    expect(spawnFailureQuarantine.inspectRetainedFailedSpawnAdmissions()).toEqual([
      expect.objectContaining({
        childSessionKey,
        status: "retrying",
        retryScheduled: true,
      }),
    ]);

    const blockedResult = await spawnOrdinaryWorker("while-accepted-abort-cleanup-retained");
    expect(blockedResult.status).toBe("forbidden");
    expect(blockedResult.error).toContain("max active children");
  });

  it("reports confirmed reserved cleanup when deletion succeeds within the bound", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    let deleteAttempts = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts < 3) {
          throw new Error("cleanup unavailable");
        }
      }
      return { ok: true };
    });

    await expect(
      spawnSubagentDirect(
        {
          task: "release the reserved identities after confirmed cleanup",
          agentId: "worker",
          expectsCompletionMessage: false,
        },
        {
          agentSessionKey: "agent:main:main",
          authorizedTargetAgentId: "worker",
          preallocatedChildSessionKey: "agent:worker:subagent:eventual-delete-child",
          preallocatedRunId: "eventual-delete-run",
          pluginOwnerId: "agentic-os",
          reservedSubagentClaimToken: "eventual-delete-claim",
        },
      ),
    ).resolves.toMatchObject({
      status: "error",
      error: "gateway request timeout for agent",
      childSessionKey: "agent:worker:subagent:eventual-delete-child",
      runId: "eventual-delete-run",
      reservedCleanup: { sessionDeletion: "deleted" },
    });
    expect(deleteAttempts).toBe(3);
  });

  it("uses the post-fork child session identity for reserved cleanup", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["main"] } },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      if (method.startsWith("sessions.")) {
        throw new Error("cleanup unavailable");
      }
      return { ok: true };
    });

    const result = await spawnSubagentDirect(
      {
        task: "fail after fork so reserved cleanup must target the forked child identity",
        agentId: "main",
        context: "fork",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "main",
        preallocatedChildSessionKey: "agent:main:subagent:reserved-fork-cleanup-child",
        preallocatedRunId: "reserved-fork-cleanup-run",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "reserved-fork-cleanup-claim",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      reservedCleanup: {
        sessionDeletion: "indeterminate",
        sessionIdentity: {
          expectedSessionId: "forked-session-id",
        },
      },
    });
    const agentParams = hoisted.dispatchGatewayMethodInProcessMock.mock.calls
      .filter(([method]) => method === "agent")
      .map(([, params]) => requireRecord(params));
    expect(agentParams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ expectedExistingSessionId: "forked-session-id" }),
      ]),
    );
    const deleteParams = hoisted.dispatchGatewayMethodInProcessMock.mock.calls
      .filter(([method]) => method === "sessions.delete")
      .map(([, params]) => requireRecord(params));
    expect(deleteParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ expectedSessionId: "forked-session-id" })]),
    );
  });

  it("returns reserved cleanup indeterminate at the deletion timeout boundary", async () => {
    const cleanupApi = await import("./subagent-spawn-cleanup.js");
    hoisted.callGatewayMock.mockRejectedValue(new Error("gateway unavailable"));

    const result = await cleanupApi.cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: "agent:worker:subagent:timeout-boundary",
      deleteTranscript: true,
      waitForSessionDeletion: { maxAttempts: 10, maxElapsedMs: 0, retryDelayMs: 0 },
    });

    expect(result.sessionDeletion).toBe("indeterminate");
    expect(hoisted.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the reserved cleanup claim fail-closed until confirmed deletion", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), subagents: { allowAgents: ["worker"] } },
        list: [
          { id: "main", workspace: "/tmp/workspace-main" },
          { id: "worker", workspace: "/tmp/workspace-worker" },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.updateSessionStoreMock.mockImplementation(async (_storePath, mutator) => {
      await mutator(store);
      return store;
    });
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    let deleteAttempts = 0;
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("gateway request timeout for agent");
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        throw new Error("cleanup unavailable");
      }
      return { ok: true };
    });

    const first = await spawnSubagentDirect(
      {
        task: "retain the reserved identities after indeterminate cleanup",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:ambiguous-reserved-child-held",
        preallocatedRunId: "ambiguous-reserved-run-held",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "ambiguous-reserved-claim",
      },
    );
    expect(first).toMatchObject({
      status: "error",
      reservedCleanup: { sessionDeletion: "indeterminate" },
    });
    expect(deleteAttempts).toBe(3);

    const duplicate = await spawnSubagentDirect(
      {
        task: "duplicate should still be rejected by the undeleted child session",
        agentId: "worker",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: "agent:main:main",
        authorizedTargetAgentId: "worker",
        preallocatedChildSessionKey: "agent:worker:subagent:ambiguous-reserved-child-held",
        preallocatedRunId: "ambiguous-reserved-run-held",
        pluginOwnerId: "agentic-os",
        reservedSubagentClaimToken: "ambiguous-reserved-claim-2",
      },
    );
    expect(duplicate).toMatchObject({
      status: "error",
      error: expect.stringContaining("reserved childSessionKey already exists"),
    });
  });

  it.each(inheritedSpawnPreferenceCases)(
    "$name",
    async ({
      task,
      requesterState,
      preferenceKey,
      expected,
      agentDefaults,
      requesterAgent,
      sessionStoreUnavailable,
      swarmEnabled,
      collect,
      requesterRunId,
    }) => {
      if (agentDefaults || requesterAgent || swarmEnabled) {
        hoisted.configOverride = createConfigOverride({
          ...(agentDefaults || requesterAgent
            ? {
                agents: {
                  defaults: { workspace: os.tmpdir(), ...agentDefaults },
                  list: [{ id: "main", workspace: "/tmp/workspace-main", ...requesterAgent }],
                },
              }
            : {}),
          ...(swarmEnabled ? { tools: { swarm: true } } : {}),
        });
      }
      if (sessionStoreUnavailable) {
        hoisted.loadSessionStoreMock.mockImplementation(() => {
          throw new Error("store unavailable");
        });
      } else {
        hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": requesterState });
      }
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawnSubagentDirect(
        { task, ...(collect ? { collect: true } : {}) },
        { agentSessionKey: "agent:main:main", ...(requesterRunId ? { requesterRunId } : {}) },
      );

      expect(result.status).toBe("accepted");
      expect(persistedStore?.[result.childSessionKey as string]?.[preferenceKey]).toBe(expected);
    },
  );

  it("prefers requester agent thinkingDefault over selected-model thinking fallback", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit selected model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("inherits requester selected-model thinking when caller session has no stored thinking or agent default", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit selected model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("prefers requester agent thinkingDefault over runtime-model thinking fallback", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
            thinkingDefault: "high",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit runtime model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("high");
  });

  it("inherits requester runtime-model thinking when caller session has no stored thinking or agent default", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        modelProvider: "openai-codex",
        model: "gpt-5.4",
      },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit runtime model thinking",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("inherits provider/model thinking default when no caller-specific default exists", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          model: "openai-codex/gpt-5.4",
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                thinking: "low",
              },
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: "/tmp/workspace-main",
          },
        ],
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {},
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inherit provider model thinking default",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    expect(persistedStore?.[childSessionKey]?.thinkingLevel).toBe("low");
  });

  it("keeps controller ownership separate from completion ownership", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });
    await spawnSubagentDirect(
      {
        task: "background work",
      },
      {
        agentSessionKey: "agent:main:telegram:default:direct:456",
        completionOwnerKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:direct:456",
      },
    );

    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput.controllerSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(registerInput.requesterSessionKey).toBe("agent:main:main");
    expect(registerInput.requesterDisplayKey).toBe("agent:main:main");
    const childSessionKey = registerInput.childSessionKey;
    if (typeof childSessionKey !== "string") {
      throw new Error("registered childSessionKey must be a string");
    }
    expect(persistedStore?.[childSessionKey]?.completionOwnerSessionKey).toBe("agent:main:main");
    expect(persistedStore?.[childSessionKey]?.inheritedToolPolicyVersion).toBe(1);
  });

  it("persists the spawning session as the stable swarm limit owner", async () => {
    hoisted.configOverride = createConfigOverride({ tools: { swarm: true } });
    const spawningSessionKey = "agent:main:telegram:default:direct:456";

    await spawnSubagentDirect(
      { task: "collect for routed completion", collect: true, groupId: "routed" },
      {
        agentSessionKey: spawningSessionKey,
        completionOwnerKey: "agent:main:main",
        requesterRunId: "parent-run",
      },
    );

    expect(firstRegisteredSubagentRun()).toMatchObject({
      requesterSessionKey: "agent:main:main",
      swarmRequesterSessionKey: spawningSessionKey,
    });
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenCalledWith("routed", spawningSessionKey);
  });

  it("keeps spawn cwd separate from inherited agent workspace", async () => {
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "work in the requested repo",
        cwd: "/tmp/task-repo",
      },
      {
        agentSessionKey: "agent:main:main",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    const childSessionKey = result.childSessionKey as string;
    const childEntry = persistedStore?.[childSessionKey];
    expect(childEntry?.spawnedWorkspaceDir).toBe("/tmp/requester-workspace");
    expect(childEntry?.spawnedCwd).toBe("/tmp/task-repo");

    const agentRequest = gatewayRequest("agent");
    const agentParams = requireRecord(agentRequest.params);
    expect(agentParams).not.toHaveProperty("cwd");
    expect(agentParams).not.toHaveProperty("workspaceDir");
  });

  it("omits requesterOrigin threadId when no requester thread is provided", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "inspect unthreaded spawn",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
      },
    );

    expect(result.status).toBe("accepted");
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    expect(requesterOrigin.channel).toBe("discord");
    expect(requesterOrigin.accountId).toBe("acct-1");
    expect(requesterOrigin.to).toBe("user-1");
    expect(requesterOrigin).not.toHaveProperty("threadId");
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: Array<{ method?: string; scopes?: string[] }> = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify per-method scope routing",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.thinking).toBe("high");
  });

  it("does not forward inherited requester thinking as an explicit agent override", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-inherited-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": { thinkingLevel: "xhigh" },
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify inherited thinking is session state",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = requireRecord(agentCall?.params);
    expect(params.thinking).toBeUndefined();
  });

  it("does not duplicate long subagent task text in the initial user message (#72019)", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-no-dup", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const task = "UNIQUE_LONG_SUBAGENT_TASK_TOKEN\n  keep indentation";
    const result = await spawnSubagentDirect(
      {
        task,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("accepted");
    const agentCall = calls.find((call) => call.method === "agent");
    const params = agentCall?.params as { message?: string; extraSystemPrompt?: string };
    expect(params.message).toContain("[Subagent Task]");
    expect(params.message).toContain("UNIQUE_LONG_SUBAGENT_TASK_TOKEN");
    expect(params.message).toContain("  keep indentation");
    expect(params.message).not.toContain("**Your Role**");
    expect(params.extraSystemPrompt).toBe("system-prompt");
  });

  it("returns an error when the initial child session patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );
    hoisted.updateSessionStoreMock.mockRejectedValueOnce(new Error("invalid model: bad-model"));

    const result = await spawnSubagentDirect(
      {
        task: "verify patch rejection",
        model: "bad-model",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("error");
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
