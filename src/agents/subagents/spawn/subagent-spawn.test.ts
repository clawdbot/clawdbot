import os from "node:os";
// Subagent spawn tests cover target policy, session patching, runtime model
// persistence, registry registration, and lifecycle event emission.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  loadFullModelCatalogMock: vi.fn(async () => {
    throw new Error("full model catalog should not materialize");
  }),
  loadPreparedModelCatalogMock: vi.fn(),
  resolveProviderRefOwnershipMock: vi.fn(),
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
  listSwarmRunsForGroupMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn<
    (params: { sessionKey?: string }) => {
      sandboxed: boolean;
      sandboxRequired: boolean;
      isolationSubject?: import("../../sandbox/types.js").SandboxIsolationSubject;
      createdActor?: import("../../../config/sessions/session-entry-provenance.js").SessionCreatedActor;
    }
  >(),
  configOverride: {} as Record<string, unknown>,
}));

let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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

function expectNoChildSpawnSideEffects(): void {
  expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
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
      resolveProviderRefOwnershipMock: hoisted.resolveProviderRefOwnershipMock,
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
      resolveSubagentSpawnModelSelection: () => "openai/gpt-5.4",
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
  });

  beforeEach(() => {
    swarmSchedulerTesting.reset();
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.loadFullModelCatalogMock.mockClear();
    hoisted.loadPreparedModelCatalogMock.mockReset().mockResolvedValue([]);
    hoisted.resolveProviderRefOwnershipMock.mockReset().mockReturnValue({
      status: "owned",
      pluginIds: ["test-provider"],
    });
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.startQueuedSubagentRunMock.mockReset().mockReturnValue(true);
    hoisted.settleFailedQueuedSubagentLaunchMock.mockReset().mockReturnValue(true);
    hoisted.completeCollectorLaunchCleanupMock.mockReset();
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.dispatchGatewayMethodInProcessMock.mockReset();
    hoisted.hasInProcessGatewayContextMock.mockReset().mockReturnValue(false);
    hoisted.resolveAgentConfigMock.mockReset();
    hoisted.resolveContextEngineMock.mockReset().mockResolvedValue({});
    hoisted.countActiveRunsForSessionMock.mockReset().mockReturnValue(0);
    hoisted.listSwarmRunsForGroupMock.mockReset().mockReturnValue([]);
    hoisted.resolveSandboxRuntimeStatusMock.mockReset().mockReturnValue({
      sandboxed: false,
      sandboxRequired: false,
    });
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
        cfg.agents?.list?.find((agent) => agent.id === agentId),
    );
    hoisted.configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.loadSessionStoreMock.mockReturnValue({});

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
  });

  afterEach(() => {
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
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

  it("inherits incognito storage ownership for direct children", async () => {
    const requesterSessionKey = "agent:main:dashboard:incognito-parent";
    const sessionPatches: Record<string, unknown>[] = [];
    const sessionStorePaths: string[] = [];
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        sessionStorePaths.push(storePath);
        const store: Record<string, Record<string, unknown>> = {};
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
    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
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
    expect(result.expectsCompletionMessage).toBe(false);
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

  it("rejects an explicit non-allowlisted model before creating child state", async () => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          modelPolicy: { allow: ["openai/gpt-5.4"] },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      },
    ]);

    const result = await spawnSubagentDirect(
      { task: "must honor model policy", model: "anthropic/claude-sonnet-4-6" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("model not allowed: anthropic/claude-sonnet-4-6");
    expectNoChildSpawnSideEffects();
  });

  it("rejects an unknown-provider model under unrestricted policy before creating child state", async () => {
    hoisted.resolveProviderRefOwnershipMock.mockReturnValue({ status: "unowned" });
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ]);

    const result = await spawnSubagentDirect(
      { task: "do not substitute an unknown provider", model: "unknown-provider/gpt-5.4" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain('unknown model provider "unknown-provider"');
    expectNoChildSpawnSideEffects();
  });

  it("does not treat ambiguous provider ownership as runnable", async () => {
    hoisted.resolveProviderRefOwnershipMock.mockReturnValue({
      status: "ambiguous",
      pluginIds: ["provider-a", "provider-b"],
    });

    const result = await spawnSubagentDirect(
      { task: "do not guess an owner", model: "ambiguous-provider/gpt-5.4" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain('unknown model provider "ambiguous-provider"');
    expectNoChildSpawnSideEffects();
  });

  it("accepts a catalog-missing model from a known provider under unrestricted policy", async () => {
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ]);

    const result = await spawnSubagentDirect(
      { task: "use a newly released model", model: "openai/gpt-new" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      modelApplied: true,
      resolvedModel: "openai/gpt-new",
      resolvedProvider: "openai",
    });
    expect(hoisted.resolveProviderRefOwnershipMock).not.toHaveBeenCalled();
  });

  it("accepts a catalog-missing model known only through provider ownership", async () => {
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([]);

    const result = await spawnSubagentDirect(
      { task: "use a plugin-owned provider", model: "plugin-provider/new-model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      resolvedModel: "plugin-provider/new-model",
      resolvedProvider: "plugin-provider",
    });
    expect(hoisted.resolveProviderRefOwnershipMock).toHaveBeenCalledWith({
      provider: "plugin-provider",
      config: hoisted.configOverride,
      workspaceDir: resolveUserPath("/tmp/workspace-main"),
    });
  });

  it("accepts a catalog-missing model from a configured custom provider", async () => {
    hoisted.configOverride = createConfigOverride({
      models: {
        providers: {
          loopback: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:43123/v1",
            models: [],
          },
        },
      },
    });
    hoisted.resolveProviderRefOwnershipMock.mockReturnValue({ status: "unowned" });

    const result = await spawnSubagentDirect(
      { task: "use the configured loopback provider", model: "loopback/new-model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({
      status: "accepted",
      modelApplied: true,
      resolvedModel: "loopback/new-model",
      resolvedProvider: "loopback",
    });
  });

  it.each([
    { policy: "exact", allow: ["future-provider/new-model"] },
    { policy: "provider wildcard", allow: ["future-provider/*"] },
  ])("rejects an unowned catalog-missing ref under a strict $policy policy", async ({ allow }) => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          modelPolicy: { allow },
        },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.resolveProviderRefOwnershipMock.mockReturnValue({ status: "unowned" });

    const result = await spawnSubagentDirect(
      { task: "do not launch an unowned provider", model: "future-provider/new-model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain('unknown model provider "future-provider"');
    expect(hoisted.resolveProviderRefOwnershipMock).toHaveBeenCalledWith({
      provider: "future-provider",
      config: hoisted.configOverride,
      workspaceDir: resolveUserPath("/tmp/workspace-main"),
    });
    expectNoChildSpawnSideEffects();
  });

  it.each([
    {
      name: "alias",
      model: "fast",
      models: { "openai/gpt-5.4": { alias: "fast" } },
    },
    {
      name: "bare model ref",
      model: "gpt-5.4",
      models: { "openai/gpt-5.4": {} },
    },
  ])("validates an explicit $name through the target policy", async ({ model, models }) => {
    hoisted.configOverride = createConfigOverride({
      agents: {
        defaults: { workspace: os.tmpdir(), models },
        list: [{ id: "main", workspace: "/tmp/workspace-main" }],
      },
    });
    hoisted.loadPreparedModelCatalogMock.mockResolvedValue([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ]);

    const result = await spawnSubagentDirect(
      { task: `use ${model}`, model },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result).toMatchObject({ status: "accepted", modelApplied: true });
  });

  it("does not load the model catalog for an implicit default", async () => {
    const result = await spawnSubagentDirect(
      { task: "inherit the default model" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.loadPreparedModelCatalogMock).not.toHaveBeenCalled();
    expect(hoisted.resolveProviderRefOwnershipMock).not.toHaveBeenCalled();
  });

  it("rejects an explicit model when catalog validation fails without creating child state", async () => {
    hoisted.loadPreparedModelCatalogMock.mockRejectedValue(new Error("catalog unavailable"));

    const result = await spawnSubagentDirect(
      { task: "validate before launch", model: "openai/gpt-5.4" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain(
      "sessions_spawn could not verify the requested model: catalog unavailable",
    );
    expectNoChildSpawnSideEffects();
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
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          agentCalls += 1;
          return { runId: `gateway-${agentCalls}` };
        }
        if (request.method === "chat.abort") {
          abortCalls += 1;
          if (!stopAllowed) {
            throw new Error("abort unavailable");
          }
          return {
            aborted: true,
            runIds: [requireRecord(request.params).runId],
          };
        }
        if (request.method === "sessions.delete") {
          throw new Error("delete unavailable");
        }
        return {};
      },
    );

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

  it("uses and validates tools.swarm.defaultAgentId for collector children", async () => {
    hoisted.configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, defaultAgentId: "worker" } },
      agents: {
        defaults: { workspace: os.tmpdir() },
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
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenLastCalledWith(
      "group",
      "agent:main:main",
      "main",
    );

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
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenCalledWith(
      "fresh",
      "agent:main:main",
      "main",
    );
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
      requesterAgentId: "main",
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

  it("reconciles a transport-ambiguous dispatch so an accepted run is surfaced instead of misreported as an error", async () => {
    let dispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; timeoutMs?: number }) => {
        if (request.method === "agent") {
          dispatchAttempts += 1;
          if (dispatchAttempts === 1) {
            throw new Error("gateway timeout after 60000ms");
          }
          if (dispatchAttempts === 2) {
            return {
              runId: "accepted-ambig-run",
              status: "in_flight",
              admissionPending: true,
            };
          }
          return { runId: "accepted-ambig-run", status: "in_flight" };
        }
        return request.method?.startsWith("sessions.") ? { ok: true } : {};
      },
    );
    const context = { agentSessionKey: "agent:main:main" };

    const result = await spawnSubagentDirect({ task: "ambiguous child" }, context);

    expect(dispatchAttempts).toBe(3);
    const agentRequests = gatewayRequestRecords().filter((request) => request.method === "agent");
    expect(agentRequests.map((request) => request.params)).toEqual([
      agentRequests[0]?.params,
      agentRequests[0]?.params,
      agentRequests[0]?.params,
    ]);
    expect(agentRequests.slice(1).map((request) => request.timeoutMs)).toEqual([800, 800]);
    expect(result).toMatchObject({
      status: "accepted",
      runId: "accepted-ambig-run",
      childSessionKey: expect.any(String),
    });
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not register a child when reconciliation finds a terminal run", async () => {
    let dispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent" && ++dispatchAttempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
      return request.method === "agent"
        ? { runId: "stopped-run", status: "timeout" }
        : { ok: true };
    });

    const result = await spawnSubagentDirect(
      { task: "ambiguous terminal child" },
      { agentSessionKey: "agent:main:main" },
    );

    expect(dispatchAttempts).toBe(2);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("no active subagent run (status: timeout)"),
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("shares pending child capacity between native and visible spawn paths", async () => {
    const { maybeSpawnVisibleSession } = await import("../../tools/sessions-spawn-visible.js");
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
      requesterAgentId: "main",
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
    hoisted.loadPreparedModelCatalogMock.mockImplementation(async (options: unknown) => {
      const scoped = options as {
        readOnly?: boolean;
        providerDiscoveryProviderIds?: string[];
        scopedLiveProviderDiscovery?: boolean;
      };
      if (
        scoped.readOnly !== true ||
        scoped.scopedLiveProviderDiscovery !== true ||
        scoped.providerDiscoveryProviderIds?.[0] !== "openai" ||
        scoped.providerDiscoveryProviderIds.length !== 1
      ) {
        return await hoisted.loadFullModelCatalogMock();
      }
      return [
        {
          provider: "openai",
          id: "no-tools",
          name: "No tools",
          compat: { supportsTools: false },
        },
      ];
    });

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
    expect(hoisted.loadFullModelCatalogMock).not.toHaveBeenCalled();
    expect(hoisted.loadPreparedModelCatalogMock).toHaveBeenCalledTimes(1);
    expect(hoisted.loadPreparedModelCatalogMock).toHaveBeenCalledWith({
      config: hoisted.configOverride,
      agentDir: expect.any(String),
      workspaceDir: resolveUserPath("/tmp/workspace-main"),
      readOnly: true,
      providerDiscoveryProviderIds: ["openai"],
      scopedLiveProviderDiscovery: true,
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

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for cross-agent spawns",
    async (sandboxMode) => {
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });
      hoisted.configOverride = createConfigOverride({
        session: {
          scope: "global",
        },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: os.tmpdir(),
          },
          list: [
            {
              id: "main",
              sandbox: { mode: sandboxMode },
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

      hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(resolveSandboxRuntimeStatus);

      const result = await spawnSubagentDirect(
        {
          task: "attribute worker run",
          agentId: "worker",
        },
        {
          agentSessionKey: "global",
          requesterAgentIdOverride: "main",
          sessionPermissionPolicy: { mode: "guarded", root: "/tmp/workspace-main" },
        },
      );

      if (sandboxMode === "all") {
        expect(result).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining("cannot spawn unsandboxed"),
        });
        expectNoChildSpawnSideEffects();
        return;
      }
      expect(result.status).toBe("accepted");
      expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);
      expect(persistedStore?.[result.childSessionKey as string]).toMatchObject({
        permissionMode: "guarded",
        sessionRoot: resolveUserPath("/tmp/workspace-worker"),
      });
      const registerInput = firstRegisteredSubagentRun();
      expect(registerInput.childSessionKey).toBe(result.childSessionKey);
      expect(registerInput.agentId).toBe("worker");
      expect(registerInput.requesterSessionKey).toBe("global");
      expect(registerInput.requesterAgentId).toBe("main");
    },
  );

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
    expect(result.expectsCompletionMessage).toBe(true);
    expect(result.modelApplied).toBe(true);
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expect(persistedStore?.[childSessionKey]).toMatchObject({
      sessionId: expect.any(String),
      lifecycleRevision: expect.any(String),
      spawnedBy: "agent:main:main",
      completionOwnerSessionKey: "agent:main:main",
      parentSessionKey: "agent:main:main",
      createdVia: "spawn",
      createdActor: { type: "agent", id: "main" },
      createdAt: expect.any(Number),
    });
    const registerInput = firstRegisteredSubagentRun();
    const requesterOrigin = requireRecord(registerInput.requesterOrigin);
    // Out-of-process dispatch leaves the Gateway-owned task row in place, so
    // registration must not also claim it (contrast with the in-process case above).
    expect(registerInput.taskRowOwnership).toBe("gateway_best_effort");
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

  it.each([
    { required: false, source: "profile" },
    { required: true, source: "profile" },
    { required: true, source: "channel" },
    { required: true, source: "unknown" },
  ] as const)(
    "inherits native child $source provenance only from a required parent ($required)",
    async ({ required, source }) => {
      const parentSessionKey = "agent:main:main";
      const actor = { type: "human", source, id: "profile-native-creator" } as const;
      hoisted.loadSessionStoreMock.mockReturnValue({
        [parentSessionKey]: {
          sessionId: "parent-session",
          updatedAt: 1,
          createdActor: actor,
          ...(required ? { sandbox: "required" } : {}),
        },
      });
      hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(({ sessionKey }) => ({
        sandboxed: true,
        sandboxRequired: required && sessionKey === parentSessionKey,
        ...(required && sessionKey === parentSessionKey
          ? {
              isolationSubject:
                source === "profile"
                  ? { kind: "profile" as const, profileId: actor.id }
                  : { kind: "session" as const, sessionKey: parentSessionKey },
              createdActor: actor,
            }
          : {}),
      }));
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawnSubagentDirect(
        { task: "continue under the parent's isolation policy" },
        { agentSessionKey: parentSessionKey },
      );

      expect(result.status).toBe("accepted");
      const entry = persistedStore?.[result.childSessionKey as string];
      expect(entry).toMatchObject({
        createdVia: "spawn",
        createdActor: required ? actor : { type: "agent", id: "main" },
        parentSessionKey,
      });
      expect(entry?.sandbox).toBe(required ? "required" : undefined);
    },
  );

  it("rejects a required parent spawning an unsandboxed native child before side effects", async () => {
    hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(({ sessionKey }) => ({
      sandboxed: sessionKey === "agent:main:main",
      sandboxRequired: sessionKey === "agent:main:main",
      ...(sessionKey === "agent:main:main"
        ? { isolationSubject: { kind: "profile" as const, profileId: "profile-native-creator" } }
        : {}),
    }));
    const result = await spawnSubagentDirect(
      { task: "try an unsandboxed child" },
      { agentSessionKey: "agent:main:main" },
    );
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("cannot spawn unsandboxed"),
    });
    expectNoChildSpawnSideEffects();
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
    // In-process dispatch claims the task row directly, unlike ACP's best-effort
    // registration (see acp-spawn.test.ts).
    expect(firstRegisteredSubagentRun().taskRowOwnership).toBe("required");
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
        timeoutMs: 60_000,
      }),
    );
  });

  it.each([
    { label: "default", mode: undefined },
    { label: "read-only", mode: "read-only" },
    { label: "guarded", mode: "guarded" },
    { label: "workspace", mode: "workspace" },
    { label: "full", mode: "full" },
  ] as const)(
    "inherits the parent's $label permission mode in a hidden child",
    async ({ mode }) => {
      const sessionRoot = resolveUserPath("/tmp/workspace-main");
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });

      const result = await spawnSubagentDirect(
        { task: "inherit the parent permission policy" },
        {
          agentSessionKey: "agent:main:main",
          workspaceDir: sessionRoot,
          ...(mode ? { sessionPermissionPolicy: { mode, root: sessionRoot } } : {}),
        },
      );

      expect(result.status).toBe("accepted");
      const childEntry = persistedStore?.[result.childSessionKey as string];
      if (mode) {
        expect(childEntry).toMatchObject({ permissionMode: mode, sessionRoot });
      } else {
        expect(childEntry).not.toHaveProperty("permissionMode");
        expect(childEntry).not.toHaveProperty("sessionRoot");
      }
    },
  );

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
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenCalledWith(
      "routed",
      spawningSessionKey,
      "main",
    );
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
    expect(childEntry?.spawnedCwd).toBe(resolveUserPath("/tmp/task-repo"));

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
