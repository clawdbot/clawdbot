// Subagent registry tests cover run state, completion capture, archive cleanup,
// persistence, lifecycle hooks, and orphan recovery scheduling.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
} from "../../../config/sessions/session-accessor.js";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../../../tasks/detached-task-runtime-contract.js";
import {
  createRunningTaskRun,
  findDetachedTaskRun,
  finalizeTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
} from "../../../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../../../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import {
  createSessionStore,
  createSubagentRunParams,
  createSubagentRunRecord,
  expectRecordFields,
  mockGatewayMethods,
  mockCallArg as getMockCallArg,
  waitForFast,
} from "../../subagent-test-fixtures.test-helpers.js";
import type {
  SubagentRunParamsOverrides,
  SubagentRunRecordOverrides,
} from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { countPendingDescendantRuns } from "./subagent-registry-read.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry.store.sqlite.js";
import type {
  ContextEngineSubagentEndedParams,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

const noop = () => {};

function findRecordCallArg(
  mock: ReturnType<typeof vi.fn>,
  argIndex: number,
  label: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  for (const call of mock.mock.calls as unknown[][]) {
    const value = call[argIndex];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const record = value as Record<string, unknown>;
    if (predicate(record)) {
      return record;
    }
  }
  throw new Error(`expected ${label}`);
}

async function expectPathMissing(targetPath: string): Promise<void> {
  // Cleanup assertions need ENOENT proof; fs.access success means the artifact
  // directory survived when lifecycle cleanup should have removed it.
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

const mocks = vi.hoisted(() => ({
  callGateway:
    vi.fn<
      (request: {
        method?: string;
        params?: Record<string, unknown>;
        scopes?: string[];
        timeoutMs?: number | null;
      }) => Promise<Record<string, unknown>>
    >(),
  onAgentEvent: vi.fn<(_handler: (event: AgentEventPayload) => void) => typeof noop>(() => noop),
  getAgentRunContext: vi.fn<(_runId: string) => unknown>(() => undefined),
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(() => ({
    agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    session: { mainKey: "main", scope: "per-sender" as const },
  })),
  loadSessionEntry: vi.fn((scope: SessionAccessScope) => {
    const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
      string,
      SessionEntry
    >;
    return store[scope.sessionKey];
  }),
  listSessionEntriesCore: vi.fn((scope: Omit<SessionAccessScope, "sessionKey">) => {
    const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
      string,
      SessionEntry
    >;
    return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  }),
  loadSessionStore: vi.fn((_storePath?: string, _options?: { clone?: boolean }) => ({})),
  patchSessionEntryCore: vi.fn(
    async (
      scope: SessionAccessScope,
      update: (
        entry: SessionEntry,
        context: SessionEntryPatchContext,
      ) => Partial<SessionEntry> | null | Promise<Partial<SessionEntry> | null>,
      options: SessionEntryPatchOptions = {},
    ) => {
      let updatedEntry: SessionEntry | null = null;
      const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
        string,
        SessionEntry
      >;
      const currentEntry = store[scope.sessionKey];
      if (!currentEntry) {
        return null;
      }
      const patch = await update(currentEntry, { existingEntry: { ...currentEntry } });
      if (!patch) {
        return currentEntry;
      }
      const applyPatch = (targetStore: Record<string, SessionEntry>) => {
        const targetEntry = targetStore[scope.sessionKey] ?? currentEntry;
        updatedEntry = options.replaceEntry
          ? (patch as SessionEntry)
          : { ...targetEntry, ...patch };
        targetStore[scope.sessionKey] = updatedEntry;
      };
      mocks.updateSessionStore(scope.storePath, applyPatch);
      applyPatch(store);
      return updatedEntry;
    },
  ),
  resolveAgentIdFromSessionKey: vi.fn((sessionKey: string) => {
    return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
  }),
  resolveStorePath: vi.fn(() => "/tmp/test-session-store.json"),
  updateSessionStore: vi.fn(),
  emitSessionLifecycleEvent: vi.fn(),
  clearSubagentRunsReadCacheForTest: vi.fn(),
  persistSubagentRunsToDisk: vi.fn(),
  persistSubagentRunsToDiskOrThrow: vi.fn(),
  restoreSubagentRunsFromDisk: vi.fn(() => 0),
  getSubagentRunsSnapshotForRead: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  getSubagentRunsSnapshotForChildSession: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  getSubagentRunsSnapshotForController: vi.fn(
    (runs: Map<string, import("./subagent-registry.types.js").SubagentRunRecord>) => new Map(runs),
  ),
  captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
  runSubagentAnnounceFlow: vi.fn(async (): Promise<"delivered" | "retryable"> => "delivered"),
  maybeWakeRequesterAfterAllChildrenSettled: vi.fn(
    async (wakeParams: {
      settledEntry: { runId: string };
      completeBatch(runIds: readonly string[]): void;
    }) => {
      wakeParams.completeBatch([wakeParams.settledEntry.runId]);
      return false;
    },
  ),
  getGlobalHookRunner: vi.fn(() => null),
  ensureContextEnginesInitialized: vi.fn(),
  loadAgentRuntimePluginRegistryHandle: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn<
    (params: { childSessionKey?: string }, context?: unknown) => Promise<void>
  >(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
  dispatchRecoveryAgent: vi.fn(),
  getGatewayRecoveryRuntime: vi.fn(() => ({
    dispatchAgent: mocks.dispatchRecoveryAgent as GatewayRecoveryRuntime["dispatchAgent"],
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  })),
  lifecycleGeneration: "test-generation",
}));

vi.mock("../../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => mocks.lifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent: (generation: string) =>
    generation === mocks.lifecycleGeneration,
  onAgentEvent: mocks.onAgentEvent,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: mocks.getAgentRunContext,
}));

vi.mock("../../../config/config.js", () => {
  return {
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore: mocks.resolveStorePath,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: mocks.listSessionEntriesCore,
  listSessionEntriesReadOnly: mocks.listSessionEntriesCore,
  loadSessionEntry: mocks.loadSessionEntry,
  loadSessionEntryReadOnly: mocks.loadSessionEntry,
  patchSessionEntryCore: mocks.patchSessionEntryCore,
}));

vi.mock("../../../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagent-registry-state.js", () => ({
  clearSubagentRunsReadCacheForTest: mocks.clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForChildSession: mocks.getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController: mocks.getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow: mocks.persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("../../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../../../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("../../internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: mocks.removeInternalSessionEffectsSession,
}));

describe("subagent registry seam flow", () => {
  type RegistryModule = typeof import("./subagent-registry.test-helpers.js");
  type RegistryHarness = Omit<RegistryModule, "addSubagentRunForTests" | "registerSubagentRun"> & {
    addSubagentRunForTests(entry: SubagentRunRecordOverrides): void;
    registerSubagentRun(params: SubagentRunParamsOverrides): void;
  };
  type RunRecordFixtureOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
    Partial<Omit<SubagentRunRecordOverrides, "runId">>;
  type KilledRunOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
    Required<Pick<SubagentRunRecord, "task" | "createdAt">> &
    Partial<Omit<SubagentRunRecordOverrides, "runId" | "task" | "createdAt">>;
  type RunningTaskParams = Parameters<typeof createRunningTaskRun>[0];
  type RunningTaskParamsOverrides = Required<
    Pick<RunningTaskParams, "runId" | "childSessionKey" | "startedAt">
  > &
    Pick<RunningTaskParams, "task"> &
    Partial<Omit<RunningTaskParams, "runId" | "childSessionKey" | "startedAt" | "task">>;
  type QueuedRunOverrides = Pick<SubagentRunRecordOverrides, "runId" | "createdAt" | "groupId"> &
    Partial<
      Omit<SubagentRunRecordOverrides, "runId" | "createdAt" | "groupId" | "queuedLaunch">
    > & {
      queuedLaunch?: Partial<NonNullable<SubagentRunRecord["queuedLaunch"]>>;
    };
  type SuspendedDeliveryRunOverrides = Pick<SubagentRunRecordOverrides, "runId"> &
    Required<
      Pick<
        SubagentRunRecord,
        "childSessionKey" | "requesterSessionKey" | "requesterDisplayKey" | "task" | "createdAt"
      >
    > & {
      endedAt: number;
      delivery: Partial<NonNullable<SubagentRunRecord["delivery"]>>;
    } & Partial<
      Omit<
        SubagentRunRecordOverrides,
        | "runId"
        | "childSessionKey"
        | "requesterSessionKey"
        | "requesterDisplayKey"
        | "task"
        | "createdAt"
        | "startedAt"
        | "endedAt"
        | "outcome"
        | "expectsCompletionMessage"
        | "delivery"
      >
    >;

  const makeKilledRun = (
    killedAt: number,
    overrides: KilledRunOverrides,
  ): SubagentRunRecordOverrides => ({
    endedAt: killedAt,
    endedReason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: { status: "error", error: "manual kill" },
    suppressAnnounceReason: "killed",
    killReconciliation: { killedAt },
    cleanupHandled: true,
    cleanupCompletedAt: killedAt,
    ...overrides,
  });
  const makeCompletedCollectorRun = (
    overrides: RunRecordFixtureOverrides,
  ): SubagentRunRecordOverrides => ({
    collect: true,
    collectorCompletion: { status: "done" },
    ...overrides,
  });
  const makeRunningTaskParams = (overrides: RunningTaskParamsOverrides): RunningTaskParams => ({
    runtime: "subagent",
    sourceId: overrides.runId,
    ownerKey: "agent:main:main",
    scopeKind: "session",
    deliveryStatus: "pending",
    lastEventAt: overrides.startedAt,
    ...overrides,
  });
  const makeQueuedRun = ({
    queuedLaunch: queuedLaunchOverrides,
    ...overrides
  }: QueuedRunOverrides): SubagentRunRecord => {
    const childSessionKey = overrides.childSessionKey ?? `agent:main:subagent:${overrides.runId}`;
    const requesterSessionKey = overrides.requesterSessionKey ?? "agent:main:main";
    return createSubagentRunRecord({
      childSessionKey,
      requesterSessionKey,
      requesterDisplayKey: "main",
      task: overrides.runId,
      cleanup: "keep",
      collect: true,
      execution: { status: "queued" },
      completion: { required: false },
      ...overrides,
      queuedLaunch: {
        request: {
          sessionKey: childSessionKey,
          idempotencyKey: overrides.runId,
        },
        timeoutMs: 1_000,
        schedulerGroupKey: JSON.stringify([requesterSessionKey, overrides.groupId]),
        maxConcurrent: 1,
        ...queuedLaunchOverrides,
      },
    });
  };
  const makeSuspendedDeliveryRun = ({
    delivery: deliveryOverrides,
    ...overrides
  }: SuspendedDeliveryRunOverrides): SubagentRunRecordOverrides => ({
    expectsCompletionMessage: true,
    startedAt: overrides.createdAt,
    outcome: { status: "ok" },
    ...overrides,
    delivery: {
      status: "suspended",
      createdAt: overrides.createdAt,
      attemptCount: 3,
      lastError: "gateway request timeout for agent",
      payload: {
        requesterSessionKey: overrides.requesterSessionKey,
        requesterDisplayKey: overrides.requesterDisplayKey,
        childSessionKey: overrides.childSessionKey,
        childRunId: overrides.runId,
        task: overrides.task,
        endedAt: overrides.endedAt,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
      suspendedReason: "expiry",
      ...deliveryOverrides,
    },
  });
  let mod: RegistryHarness;
  const recoveryRuntime: GatewayRecoveryRuntime = {
    abortAgent: vi.fn(),
    dispatchAgent: mocks.dispatchRecoveryAgent as GatewayRecoveryRuntime["dispatchAgent"],
    waitForAgent: (params, timeoutMs) =>
      mocks.callGateway({
        method: "agent.wait",
        params: params as unknown as Record<string, unknown>,
        timeoutMs,
      }) as never,
    sendRecoveryNotice: vi.fn(),
  };
  const activateRegistry = () =>
    mod.activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime,
          resolveGatewayContext: () => ({ recoveryRuntime }),
        }) as never,
    );
  const hydrateAndActivateRegistry = () => {
    mod.initSubagentRegistry();
    activateRegistry();
  };
  const findRequesterRun = (runId: string) =>
    mod.listSubagentRunsForRequester("agent:main:main").find((entry) => entry.runId === runId);
  const mockPendingAgentWait = () =>
    mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "pending" } });
  const mockSingleCollectorConcurrency = () =>
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
  const getLifecycleHandler = () => {
    const handler = mocks.onAgentEvent.mock.calls.at(-1)?.[0] as unknown as
      | ((event: {
          runId: string;
          stream: string;
          data: Record<string, unknown>;
          seq?: number;
          ts?: number;
          sessionKey?: string;
        }) => void)
      | undefined;
    if (!handler) {
      throw new Error("expected lifecycle handler");
    }
    return handler;
  };

  beforeAll(async () => {
    const registry = await import("./subagent-registry.test-helpers.js");
    mod = {
      ...registry,
      addSubagentRunForTests: (entry) =>
        registry.addSubagentRunForTests(createSubagentRunRecord(entry)),
      registerSubagentRun: (params) =>
        registry.registerSubagentRun(createSubagentRunParams(params)),
    };
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDetachedTaskLifecycleRuntimeForTests();
    vi.clearAllMocks();
    mocks.callGateway.mockReset();
    mocks.captureSubagentCompletionReply.mockReset().mockResolvedValue("final completion reply");
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockReset().mockResolvedValue(undefined);
    mocks.persistSubagentRunsToDisk.mockReset();
    mocks.persistSubagentRunsToDiskOrThrow.mockReset();
    mocks.restoreSubagentRunsFromDisk.mockReset().mockReturnValue(0);
    mocks.runSubagentAnnounceFlow.mockReset().mockResolvedValue("delivered");
    mocks.maybeWakeRequesterAfterAllChildrenSettled
      .mockReset()
      .mockImplementation(async (params) => {
        params.completeBatch([params.settledEntry.runId]);
        return false;
      });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
    mocks.lifecycleGeneration = "test-generation";
    mocks.onAgentEvent.mockReturnValue(noop);
    mocks.getAgentRunContext.mockReturnValue(undefined);
    mocks.getRuntimeConfig.mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    mocks.resolveAgentIdFromSessionKey.mockImplementation((sessionKey: string) => {
      return sessionKey.match(/^agent:([^:]+)/)?.[1] ?? "main";
    });
    mocks.resolveStorePath.mockReturnValue("/tmp/test-session-store.json");
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({ lifecycleRevision: "revision-child" }),
    );
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(pluginRegistry);
    mocks.runSubagentEnded.mockImplementation(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
    });
    mocks.dispatchRecoveryAgent.mockReset();
    mocks.resolveAgentTimeoutMs.mockReturnValue(1_000);
    mocks.getSubagentRunsSnapshotForChildSession
      .mockReset()
      .mockImplementation((runs) => new Map(runs));
    mocks.getSubagentRunsSnapshotForController
      .mockReset()
      .mockImplementation((runs) => new Map(runs));
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
      },
    });
    mocks.dispatchRecoveryAgent.mockImplementation(async (params, timeoutMs, options) =>
      mocks.callGateway({
        method: "agent",
        params: params as unknown as Record<string, unknown>,
        timeoutMs,
        ...(options?.scopes ? { scopes: options.scopes } : {}),
      }),
    );
    mod.testing.setDepsForTest({
      callGateway: mocks.callGateway as typeof import("../../../gateway/call.js").callGateway,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: mocks.cleanupBrowserSessionsForLifecycleEnd,
      onAgentEvent: mocks.onAgentEvent,
      persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
      persistSubagentRunsToDiskOrThrow: mocks.persistSubagentRunsToDiskOrThrow,
      resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
      restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
      runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
      // Registry seam tests must not run the real settle wake: it holds
      // tracked root work through its own async gating, which races the
      // root-count drain assertions here. Wake behavior has its own suites.
      maybeWakeRequesterAfterAllChildrenSettled: mocks.maybeWakeRequesterAfterAllChildrenSettled,
      ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
      loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
      resolveContextEngine: mocks.resolveContextEngine,
    });
    mod.resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    resetDetachedTaskLifecycleRuntimeForTests();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps a sweeper archive mutation root-admitted until deletion settles", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore(
        {
          lifecycleRevision: "revision-sweep-admission",
          sessionId: "session-sweep-admission",
        },
        "agent:main:subagent:sweep-admission",
      ),
    );
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests({
      runId: "run-sweep-admission",
      childSessionKey: "agent:main:subagent:sweep-admission",
      task: "archive while suspension is possible",
      cleanup: "delete",
      createdAt: now - 10_000,
      endedAt: now - 5_000,
      cleanupCompletedAt: now - 4_000,
      archiveAtMs: now - 1,
    });

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseDelete?.();
    await sweep;
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("archives completed collector groups only after every member reaches TTL", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:collector-one": {
        lifecycleRevision: "revision-collector-one",
        sessionId: "session-collector-one",
        updatedAt: now,
      },
      "agent:main:subagent:collector-two": {
        lifecycleRevision: "revision-collector-two",
        sessionId: "session-collector-two",
        updatedAt: now,
      },
    });
    for (const [suffix, archiveAtMs] of [
      ["one", now - 1],
      ["two", now + 1_000],
    ] as const) {
      mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId: `run-collector-${suffix}`,
          childSessionKey: `agent:main:subagent:collector-${suffix}`,
          task: "retain lifetime group count",
          cleanup: suffix === "one" ? "keep" : "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs,
          groupId: "swarm:lifetime",
        }),
      );
    }

    await mod.testing.sweepOnceForTests();
    expect(mod.getSubagentRunByRunId("run-collector-one")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-two")).toBeDefined();
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );

    vi.setSystemTime(now + 1_001);
    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-one")).toBeUndefined();
    expect(mod.getSubagentRunByRunId("run-collector-two")).toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "sessions.delete"),
    ).toHaveLength(2);
  });

  it("keeps collector archive groups scoped to their requester", async () => {
    const now = Date.now();
    for (const [requesterSessionKey, archiveAtMs] of [
      ["agent:main:requester-one", now - 1],
      ["agent:main:requester-two", now + 1_000],
    ] as const) {
      mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId: `run-${requesterSessionKey}`,
          childSessionKey: `${requesterSessionKey}:subagent:collector`,
          requesterSessionKey,
          task: "retain requester-scoped collector groups",
          cleanup: "delete",
          createdAt: now - 10_000,
          endedAt: now - 5_000,
          cleanupCompletedAt: now - 4_000,
          archiveAtMs,
          groupId: "swarm:shared-group-id",
        }),
      );
    }

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-agent:main:requester-one")).toBeUndefined();
    expect(mod.getSubagentRunByRunId("run-agent:main:requester-two")).toBeDefined();
  });

  it("keeps completed collectors while any group member is incomplete", async () => {
    const now = Date.now();
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-complete",
        childSessionKey: "agent:main:subagent:collector-complete",
        task: "completed collector",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:incomplete-member",
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-collector-incomplete",
      childSessionKey: "agent:main:subagent:collector-incomplete",
      task: "incomplete collector",
      createdAt: now - 9_000,
      endedAt: now - 4_000,
      archiveAtMs: now + 1_000,
      collect: true,
      groupId: "swarm:incomplete-member",
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-complete")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-incomplete")).toBeDefined();
  });

  it("refreshes collector membership after awaited sweep work", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore(
        {
          lifecycleRevision: "revision-archive-blocker",
          sessionId: "session-archive-blocker",
        },
        "agent:main:subagent:archive-blocker",
      ),
    );
    let releaseFirstDelete: (() => void) | undefined;
    let shouldBlockDelete = true;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || !shouldBlockDelete) {
        return Promise.resolve({});
      }
      shouldBlockDelete = false;
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseFirstDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests({
      runId: "run-archive-blocker",
      childSessionKey: "agent:main:subagent:archive-blocker",
      task: "hold the sweep before collector archival",
      cleanup: "delete",
      createdAt: now - 10_000,
      endedAt: now - 5_000,
      cleanupCompletedAt: now - 4_000,
      archiveAtMs: now - 1,
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-before-await",
        childSessionKey: "agent:main:subagent:collector-before-await",
        task: "completed collector present at sweep start",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:late-member",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseFirstDelete).toBeTypeOf("function"));
    mod.addSubagentRunForTests({
      runId: "run-collector-after-await",
      childSessionKey: "agent:main:subagent:collector-after-await",
      task: "incomplete collector registered during sweep",
      createdAt: now,
      collect: true,
      groupId: "swarm:late-member",
    });
    releaseFirstDelete?.();
    await sweep;

    expect(mod.getSubagentRunByRunId("run-collector-before-await")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-after-await")).toBeDefined();
  });

  it("revalidates collector membership after collector cleanup awaits", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore(
        {
          lifecycleRevision: "revision-collector-cleanup-snapshot",
          sessionId: "session-collector-cleanup-snapshot",
        },
        "agent:main:subagent:collector-cleanup-snapshot",
      ),
    );
    let releaseCollectorDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || releaseCollectorDelete) {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseCollectorDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-cleanup-snapshot",
        childSessionKey: "agent:main:subagent:collector-cleanup-snapshot",
        task: "completed collector present before cleanup",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:cleanup-race",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseCollectorDelete).toBeTypeOf("function"));
    mod.addSubagentRunForTests({
      runId: "run-collector-added-during-cleanup",
      childSessionKey: "agent:main:subagent:collector-added-during-cleanup",
      task: "incomplete collector registered during cleanup",
      createdAt: now,
      collect: true,
      groupId: "swarm:cleanup-race",
    });
    releaseCollectorDelete?.();
    await sweep;

    expect(mod.getSubagentRunByRunId("run-collector-cleanup-snapshot")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-added-during-cleanup")).toBeDefined();
  });

  it("keeps a collector replaced during collector cleanup awaits", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore(
        {
          lifecycleRevision: "revision-collector-before-replacement",
          sessionId: "session-collector-before-replacement",
        },
        "agent:main:subagent:collector-before-replacement",
      ),
    );
    let releaseCollectorDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation((request: { method?: string }) => {
      if (request.method !== "sessions.delete" || releaseCollectorDelete) {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseCollectorDelete = () => resolve({});
      });
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-replaced-during-cleanup",
        childSessionKey: "agent:main:subagent:collector-before-replacement",
        task: "collector before replacement",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:replacement-race",
      }),
    );

    const sweep = mod.testing.runSweeperTickForTests();
    await waitForFast(() => expect(releaseCollectorDelete).toBeTypeOf("function"));
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-replaced-during-cleanup",
        childSessionKey: "agent:main:subagent:collector-after-replacement",
        task: "collector after replacement",
        createdAt: now,
        endedAt: now,
        archiveAtMs: now - 1,
        groupId: "swarm:replacement-race",
      }),
    );
    releaseCollectorDelete?.();
    await sweep;

    expect(
      mod.getSubagentRunByRunId("run-collector-replaced-during-cleanup")?.childSessionKey,
    ).toBe("agent:main:subagent:collector-after-replacement");
  });

  it("keeps collector groups while any member owes failed-launch cleanup", async () => {
    const now = Date.now();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:collector-clean": {
        lifecycleRevision: "revision-collector-clean",
        sessionId: "session-collector-clean",
        updatedAt: now,
      },
      "agent:main:subagent:collector-cleanup-pending": {
        lifecycleRevision: "revision-collector-cleanup-pending",
        sessionId: "session-collector-cleanup-pending",
        updatedAt: now,
      },
    });
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-collector-clean",
        childSessionKey: "agent:main:subagent:collector-clean",
        task: "completed sibling",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        archiveAtMs: now - 1,
        groupId: "swarm:cleanup-pending",
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-collector-cleanup-pending",
      childSessionKey: "agent:main:subagent:collector-cleanup-pending",
      task: "failed launch cleanup",
      createdAt: now - 9_000,
      endedAt: now - 4_000,
      archiveAtMs: now - 1,
      collect: true,
      groupId: "swarm:cleanup-pending",
      collectorLaunchCleanupPending: true,
      collectorCompletion: { status: "failed" },
    });
    mocks.callGateway.mockRejectedValueOnce(new Error("delete unavailable"));

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByRunId("run-collector-clean")).toBeDefined();
    expect(mod.getSubagentRunByRunId("run-collector-cleanup-pending")).toMatchObject({
      collectorLaunchCleanupPending: true,
    });
  });

  it("keeps collector records when attachment cleanup cannot prove a safe path", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-swarm-archive-"));
    const attachmentsRootDir = path.join(tempRoot, "root");
    const attachmentsDir = path.join(tempRoot, "outside");
    await fs.mkdir(attachmentsRootDir);
    await fs.mkdir(attachmentsDir);
    try {
      mod.addSubagentRunForTests(
        makeCompletedCollectorRun({
          runId: "run-collector-unsafe-attachments",
          childSessionKey: "agent:main:subagent:collector-unsafe-attachments",
          task: "retain record until attachments are safely removed",
          createdAt: Date.now() - 10_000,
          endedAt: Date.now() - 5_000,
          archiveAtMs: Date.now() - 1,
          groupId: "swarm:unsafe-attachments",
          attachmentsDir,
          attachmentsRootDir,
        }),
      );

      await mod.testing.sweepOnceForTests();

      expect(mod.getSubagentRunByRunId("run-collector-unsafe-attachments")).toBeDefined();
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("snapshots ordinary parent-chain wait ownership when registering a collector", () => {
    const parentSessionKey = "agent:main:subagent:collector-parent";
    mod.addSubagentRunForTests({
      runId: "run-ordinary-parent",
      childSessionKey: parentSessionKey,
      task: "spawn nested child",
      createdAt: Date.now(),
      expectsCompletionMessage: true,
    });
    mod.registerSubagentRun({
      runId: "run-collector-descendant",
      childSessionKey: "agent:main:subagent:collector-descendant",
      controllerSessionKey: parentSessionKey,
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: "parent",
      task: "nested result",
      expectsCompletionMessage: false,
      collect: true,
      swarmRequesterSessionKey: parentSessionKey,
      groupId: "swarm:descendant",
      queued: true,
    });

    expect(mod.getSubagentRunByRunId("run-collector-descendant")).toMatchObject({
      swarmWaitOwnerSessionKeys: [parentSessionKey, "agent:main:main"],
    });
  });

  it("tracks missing-entry lifecycle result refresh until capture and persistence settle", async () => {
    const childSessionKey = "agent:main:subagent:refresh-admission";
    mockPendingAgentWait();
    mod.registerSubagentRun({
      runId: "run-refresh-admission-old",
      childSessionKey,
      task: "capture replacement completion",
      expectsCompletionMessage: true,
    });
    await waitForFast(() => expect(mocks.callGateway).toHaveBeenCalled());
    const entry = mod.getSubagentRunByChildSessionKey(childSessionKey);
    expect(entry).not.toBeNull();
    if (entry) {
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: "ok" },
      };
    }
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    let finishCapture: ((value: string) => void) | undefined;
    mocks.captureSubagentCompletionReply.mockImplementationOnce(
      async () =>
        await new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    mocks.persistSubagentRunsToDisk.mockClear();
    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-refresh-admission-new",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: childSessionKey,
      data: { phase: "end" },
    });

    await waitForFast(() => expect(finishCapture).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    expect(entry?.completion?.resultText).toBeUndefined();

    finishCapture?.("replacement final reply");
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(entry?.completion?.resultText).toBe("replacement final reply");
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalledOnce();
  });

  it("retries a terminal completion deferred by restart drain", async () => {
    const now = Date.now();
    const runId = "run-terminal-restart-retry";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:terminal-restart-retry",
      task: "deliver terminal completion after restart",
      expectsCompletionMessage: true,
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      endedAt: now - 1_000,
      endedReason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: { status: "error", error: "provider interrupted" },
    });

    markGatewayRestartDraining();
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId,
        error: "provider interrupted",
        endedAt: now - 1_000,
      }),
    ).resolves.toBe(1);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resetGatewayWorkAdmission();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce());
    await waitForFast(() => {
      const entry = findRequesterRun(runId);
      expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
    });
  });

  it("keeps killed session timing root-admitted after task finalization", async () => {
    let finishTiming: (() => void) | undefined;
    mocks.patchSessionEntryCore.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishTiming = resolve;
      });
      return null;
    });
    mockPendingAgentWait();
    const runId = "run-kill-tail-admission";
    mod.registerSubagentRun({
      runId,
      task: "persist killed session state",
      spawnMode: "session",
    });
    await waitForFast(() => expect(mocks.callGateway).toHaveBeenCalled());

    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    await waitForFast(() => expect(finishTiming).toBeTypeOf("function"));
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "cancelled" });
    // Bookkeeping can launch additional tracked cleanup tails; the held timing
    // write must keep at least one independent root visible until it settles.
    expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);

    finishTiming?.();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("does not freeze running collector output from a provisional kill", async () => {
    const runId = "run-collector-provisional-kill";
    mod.addSubagentRunForTests({
      runId,
      task: "finish collector cancellation",
      createdAt: Date.now(),
      collect: true,
      execution: { status: "running" },
      structuredOutput: { invalidAttempts: 0, structured: { answer: 42 } },
    });

    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
    expect(mod.getSubagentRunByRunId(runId)?.structuredOutput).toEqual({
      invalidAttempts: 0,
      structured: { answer: 42 },
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("keeps an in-flight queued collector pending until launch cleanup settles", async () => {
    const runId = "run-collector-launch-kill";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:launch-kill",
      task: "cancel while gateway launch is unresolved",
      createdAt: Date.now(),
      collect: true,
      swarmRunId: runId,
      schedulerSlotId: runId,
      swarmLaunchPending: true,
      execution: { status: "queued" },
      completion: { required: false },
    });

    const launch = createDeferred();
    const started = createDeferred();
    enqueueSwarmRun({
      groupId: "delayed-acceptance",
      runId,
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {
        started.resolve();
        await launch.promise;
      },
      onStartFailure: () => true,
    });
    try {
      await started.promise;
      expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
      expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
      expect(mod.startQueuedSubagentRun(runId, "gateway-launch-kill")).toBe(false);
      expect(mod.getSubagentRunByRunId("gateway-launch-kill")).toBeUndefined();

      expect(mod.settleFailedQueuedSubagentLaunch(runId, "launch response lost")).toBe(true);
      expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toMatchObject({
        status: "killed",
      });
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      launch.resolve();
      await launch.promise;
      releaseSwarmRun(runId);
    }
  });

  it("records early structured output through the child session identity", () => {
    const childSessionKey = "agent:main:subagent:early-structured-output";
    mod.addSubagentRunForTests({
      runId: "public-collector-run",
      childSessionKey,
      task: "return structured output immediately",
      createdAt: Date.now(),
      collect: true,
      execution: { status: "queued" },
    });

    mod.recordSwarmStructuredOutput(
      { runId: "gateway-run-not-yet-remapped", childSessionKey },
      { invalidAttempts: 0, structured: { answer: 42 } },
    );

    expect(mod.getSubagentRunByRunId("public-collector-run")?.structuredOutput).toEqual({
      invalidAttempts: 0,
      structured: { answer: 42 },
    });
  });

  it("lists active and pending-delivery child sessions for maintenance preservation", () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      task: "active task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now,
    });
    mod.addSubagentRunForTests({
      runId: "run-pending",
      childSessionKey: "agent:main:subagent:pending",
      task: "pending delivery task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now - 2,
      endedAt: now - 1,
      completion: { required: true, resultText: "child output" },
      delivery: { status: "pending" },
    });
    mod.addSubagentRunForTests({
      runId: "run-complete",
      childSessionKey: "agent:main:subagent:complete",
      task: "already delivered task",
      expectsCompletionMessage: true,
      createdAt: now - 4,
      endedAt: now - 3,
      delivery: { status: "delivered", announcedAt: now - 2, deliveredAt: now - 2 },
      cleanupCompletedAt: now - 1,
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-reconciling",
      childSessionKey: "agent:main:subagent:killed-reconciling",
      task: "reconcile killed task",
      cleanup: "delete",
      expectsCompletionMessage: false,
      createdAt: now - 6,
      endedAt: now - 5,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 },
      cleanupCompletedAt: now - 4,
    });

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys().toSorted()).toEqual([
      "agent:main:subagent:active",
      "agent:main:subagent:killed-reconciling",
      "agent:main:subagent:pending",
    ]);
  });

  it("uses the disk-aware run snapshot for maintenance preservation", () => {
    const now = Date.now();
    mocks.getSubagentRunsSnapshotForRead.mockReturnValueOnce(
      new Map([
        [
          "run-restored",
          {
            runId: "run-restored",
            childSessionKey: "agent:main:subagent:restored",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "restored pending task",
            cleanup: "delete",
            expectsCompletionMessage: true,
            createdAt: now,
            execution: { status: "running" as const },
          },
        ],
      ]),
    );

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys()).toEqual([
      "agent:main:subagent:restored",
    ]);
  });

  it("retries registry restore after a transient partial-merge failure", () => {
    const runId = "run-restore-retry";
    const restored = createSubagentRunRecord({
      runId,
      task: "retry registry restore",
      cleanup: "keep",
      pauseReason: "sessions_yield",
      createdAt: Date.now(),
    });
    mocks.restoreSubagentRunsFromDisk
      .mockImplementationOnce(((params: { runs: Map<string, SubagentRunRecord> }) => {
        params.runs.set(runId, restored);
        throw new Error("transient sqlite read failure");
      }) as never)
      .mockReturnValue(0);

    hydrateAndActivateRegistry();
    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
    expect(mocks.onAgentEvent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledTimes(2);
    expect(mod.getSubagentRunByRunId(runId)?.runId).toBe(runId);
    expect(mocks.onAgentEvent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("latches registry restore only after success", () => {
    mocks.restoreSubagentRunsFromDisk.mockReturnValue(0);

    mod.initSubagentRegistry();
    mod.initSubagentRegistry();

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
  });

  it("does not double-run reentrant registry restore calls", () => {
    mocks.restoreSubagentRunsFromDisk.mockImplementation(() => {
      mod.initSubagentRegistry();
      return 0;
    });

    mod.initSubagentRegistry();

    expect(mocks.restoreSubagentRunsFromDisk).toHaveBeenCalledOnce();
  });

  it("replays a past-due requester-settle obligation during registry restore", async () => {
    const endedAt = Date.now() - 1_000;
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-settle-restore",
        createSubagentRunRecord({
          runId: "run-settle-restore",
          childSessionKey: "agent:main:subagent:settle-restore",
          task: "restore requester settle wake",
          cleanup: "delete",
          expectsCompletionMessage: true,
          createdAt: endedAt - 1_000,
          startedAt: endedAt - 900,
          endedAt,
          cleanupCompletedAt: endedAt,
          completion: { required: true, resultText: "persisted findings" },
          delivery: { status: "delivered" },
          requesterSettleWake: {
            status: "pending",
            attemptCount: 1,
            nextAttemptAt: endedAt,
            batchRunIds: ["run-settle-restore"],
            retireAfterSettle: true,
          },
        }),
      );
      return 1;
    }) as never);

    hydrateAndActivateRegistry();

    await waitForFast(() => {
      expect(mocks.maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledTimes(1);
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(mocks.maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterSessionKey: "agent:main:main",
        settledEntry: expect.objectContaining({ runId: "run-settle-restore" }),
        transitionBatch: expect.any(Function),
        completeBatch: expect.any(Function),
      }),
    );
  });

  it("does not relaunch a restored queued collector with durable kill intent", async () => {
    const now = Date.now();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-queued-kill-intent",
        makeQueuedRun({
          runId: "run-queued-kill-intent",
          childSessionKey: "agent:main:subagent:queued-kill-intent",
          task: "do not relaunch",
          groupId: "kill-intent",
          createdAt: now,
          killIntent: {
            requestedAt: now + 1,
            reason: "killed",
            sessionId: "session-queued-kill-intent",
          },
        }),
      );
      return 1;
    }) as never);

    hydrateAndActivateRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );
  });

  it("rehydrates persisted collector FIFO queues after admission reopens", async () => {
    const now = Date.now();
    mockSingleCollectorConcurrency();
    const queuedRunOverrides = {
      groupId: "logical-group",
      queuedLaunch: {
        authorization: { modelOverride: { provider: "openai", model: "gpt-5.4" } },
        maxConcurrent: 2,
      },
    };
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-queued-one",
        makeQueuedRun({ ...queuedRunOverrides, runId: "run-queued-one", createdAt: now }),
      );
      params.runs.set(
        "run-queued-two",
        makeQueuedRun({
          ...queuedRunOverrides,
          runId: "run-queued-two",
          createdAt: now + 1,
        }),
      );
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-queued-one": { sessionId: "session-one", updatedAt: now },
      "agent:main:subagent:run-queued-two": { sessionId: "session-two", updatedAt: now },
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "gateway-run-one" };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    hydrateAndActivateRegistry();
    await Promise.resolve();
    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );

    suspension?.release();
    await waitForFast(() => {
      const agentCalls = mocks.callGateway.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.[0]).toMatchObject({
        params: {
          idempotencyKey: "run-queued-one",
          provider: "openai",
          model: "gpt-5.4",
        },
        scopes: ["operator.admin"],
      });
    });
    expect(mod.getSubagentRunByRunId("run-queued-one")?.execution?.status).toBe("running");
    const acceptedRun = mod.getSubagentRunByRunId("gateway-run-one");
    expect(acceptedRun).toMatchObject({
      runId: "gateway-run-one",
      swarmRunId: "run-queued-one",
      schedulerSlotId: "run-queued-one",
      execution: { status: "running" },
    });
    expect(acceptedRun).not.toHaveProperty("startedAt");
    expect(acceptedRun).not.toHaveProperty("sessionStartedAt");
    expect(acceptedRun?.execution).not.toHaveProperty("startedAt");
    expect(mod.getSubagentRunByRunId("run-queued-two")?.execution?.status).toBe("queued");
  });

  it("preserves a lifecycle start that arrives before collector acceptance returns", async () => {
    const startedAt = 12_345;
    mod.registerSubagentRun({
      runId: "run-start-race",
      childSessionKey: "agent:main:subagent:start-race",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "start before acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "start-race",
      queued: true,
      expectsCompletionMessage: false,
    });
    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls.at(-1) as unknown as
      | [(event: AgentEventPayload) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-start-race",
      seq: 1,
      stream: "lifecycle",
      ts: startedAt,
      data: { phase: "start", startedAt },
    });
    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-start-race")?.execution.startedAt).toBe(startedAt),
    );

    expect(mod.startQueuedSubagentRun("run-start-race", "gateway-start-race")).toBe(true);
    expect(mod.getSubagentRunByRunId("gateway-start-race")).toMatchObject({
      sessionStartedAt: startedAt,
      execution: { status: "running", acceptedAt: expect.any(Number), startedAt },
    });
  });

  it("rejects queued collector acceptance from a retired Gateway lifecycle", () => {
    mod.registerSubagentRun({
      runId: "run-retired-acceptance",
      childSessionKey: "agent:main:subagent:retired-acceptance",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "reject stale acceptance",
      cleanup: "keep",
      collect: true,
      groupId: "retired-acceptance",
      queued: true,
      expectsCompletionMessage: false,
    });

    expect(
      mod.startQueuedSubagentRun(
        "run-retired-acceptance",
        "gateway-retired-acceptance",
        "retired-generation",
      ),
    ).toBe(false);
    expect(mod.getSubagentRunByRunId("run-retired-acceptance")).toMatchObject({
      execution: { status: "queued" },
    });
    expect(mod.getSubagentRunByRunId("gateway-retired-acceptance")).toBeUndefined();
  });

  it("remaps a collector that completed before its acceptance response", () => {
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-terminal-race",
        childSessionKey: "agent:main:subagent:terminal-race",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "finish before acceptance",
        cleanup: "keep",
        swarmRunId: "run-terminal-race",
        schedulerSlotId: "run-terminal-race",
        swarmLaunchPending: false,
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:terminal-race" },
          timeoutMs: 1_000,
          schedulerGroupKey: "terminal-race",
          maxConcurrent: 1,
        },
        groupId: "terminal-race",
        createdAt: 1_000,
        endedAt: 2_000,
        execution: { status: "terminal", endedAt: 2_000 },
        completion: { required: false, resultText: "done", capturedAt: 2_000 },
      }),
    );

    expect(mod.startQueuedSubagentRun("run-terminal-race", "gateway-terminal-race")).toBe(true);
    const remapped = mod.getSubagentRunByRunId("gateway-terminal-race");
    expect(mod.getSubagentRunByRunId("run-terminal-race")).toBe(remapped);
    expect(remapped).toMatchObject({
      runId: "gateway-terminal-race",
      swarmRunId: "run-terminal-race",
      collectorCompletion: { status: "done" },
      swarmLaunchPending: false,
    });
  });

  it("refuses to remap an unrelated terminal collector without a pending launch", () => {
    mod.addSubagentRunForTests(
      makeCompletedCollectorRun({
        runId: "run-terminal-stale",
        childSessionKey: "agent:main:subagent:terminal-stale",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "stale acceptance callback",
        cleanup: "keep",
        swarmRunId: "run-terminal-stale",
        schedulerSlotId: "run-terminal-stale",
        groupId: "terminal-stale",
        createdAt: 1_000,
        endedAt: 2_000,
        execution: { status: "terminal", endedAt: 2_000 },
        completion: { required: false, resultText: "done", capturedAt: 2_000 },
      }),
    );

    expect(mod.startQueuedSubagentRun("run-terminal-stale", "gateway-terminal-stale")).toBe(false);
    expect(mod.getSubagentRunByRunId("run-terminal-stale")).toMatchObject({
      runId: "run-terminal-stale",
      collectorCompletion: { status: "done" },
    });
    expect(mod.getSubagentRunByRunId("gateway-terminal-stale")).toBeUndefined();
  });

  it("holds a restored FIFO slot until an accepted collector is confirmed stopped", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-restored-stop-one",
        makeQueuedRun({ runId: "run-restored-stop-one", groupId: "restore-stop", createdAt: now }),
      );
      params.runs.set(
        "run-restored-stop-two",
        makeQueuedRun({
          runId: "run-restored-stop-two",
          groupId: "restore-stop",
          createdAt: now + 1,
        }),
      );
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-restored-stop-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-stop-two": { sessionId: "two", updatedAt: now },
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite unavailable after Gateway acceptance");
    });
    let agentCalls = 0;
    let releaseAbort: (() => void) | undefined;
    const deleteReleases: Array<() => void> = [];
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `gateway-restored-${agentCalls}` };
      }
      if (request.method === "chat.abort") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseAbort = () => resolve({});
        });
      }
      if (request.method === "sessions.delete") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          deleteReleases.push(() => resolve({}));
        });
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();
    await waitForFast(() => expect(releaseAbort).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseAbort?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(1));
    expect(agentCalls).toBe(1);
    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:subagent:run-restored-stop-one",
            expectedSessionId: "one",
            expectedLifecycleRevision: "revision-one",
          }),
        }),
      ),
    );
    deleteReleases[0]?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(2));
    expect(agentCalls).toBe(1);
    deleteReleases[1]?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
  });

  it("holds a restored FIFO slot while an indeterminate launch session is deleted", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-restored-delete-one",
        makeQueuedRun({
          runId: "run-restored-delete-one",
          groupId: "restore-delete",
          createdAt: now,
        }),
      );
      params.runs.set(
        "run-restored-delete-two",
        makeQueuedRun({
          runId: "run-restored-delete-two",
          groupId: "restore-delete",
          createdAt: now + 1,
        }),
      );
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-restored-delete-one": {
        lifecycleRevision: "revision-one",
        sessionId: "one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-delete-two": {
        lifecycleRevision: "revision-two",
        sessionId: "two",
        updatedAt: now,
      },
    });
    let agentCalls = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        if (agentCalls === 1) {
          throw new Error("launch response lost");
        }
        return { runId: "gateway-restored-second" };
      }
      if (request.method === "sessions.delete") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseDelete?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
  });

  it("releases restored FIFO ownership when lifecycle rotates during failure persistence", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-restored-rotation-one",
        makeQueuedRun({
          runId: "run-restored-rotation-one",
          groupId: "restore-lifecycle-rotation",
          createdAt: now,
        }),
      );
      params.runs.set(
        "run-restored-rotation-two",
        makeQueuedRun({
          runId: "run-restored-rotation-two",
          groupId: "restore-lifecycle-rotation",
          createdAt: now + 1,
        }),
      );
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-restored-rotation-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-rotation-two": {
        sessionId: "two",
        lifecycleRevision: "revision-two",
        updatedAt: now,
      },
    });
    let persistenceCalls = 0;
    let concurrentSweep: Promise<void> | undefined;
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation(() => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        throw new Error("sqlite unavailable after Gateway acceptance");
      }
      if (persistenceCalls === 2) {
        mocks.lifecycleGeneration = "rotated-generation";
        concurrentSweep = mod.testing.sweepOnceForTests();
        throw new Error("sqlite unavailable during failure settlement");
      }
    });
    let agentCalls = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `gateway-restored-rotation-${agentCalls}` };
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();

    await waitForFast(() => expect(persistenceCalls).toBeGreaterThanOrEqual(3));
    await concurrentSweep;
    await waitForFast(() => expect(agentCalls).toBe(2));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(mod.getSubagentRunByRunId("run-restored-rotation-one")).toMatchObject({
      execution: {
        status: "terminal",
        suppressSessionEffects: true,
        outcome: { status: "error" },
      },
      collectorCompletion: { status: "failed" },
    });
    expect(mod.getSubagentRunByRunId("gateway-restored-rotation-2")).toMatchObject({
      execution: { status: "running", lifecycleGeneration: "rotated-generation" },
    });
  });

  it("cleans prepared resources after a restored collector launch fails", async () => {
    const now = Date.now();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-queued-failure",
        makeQueuedRun({
          runId: "run-queued-failure",
          childSessionKey: "agent:main:subagent:queued-failure",
          swarmRequesterSessionKey: "agent:main:main",
          task: "fail restored launch",
          groupId: "restore-failure",
          createdAt: now,
          queuedLaunch: {
            request: { sessionKey: "agent:main:subagent:queued-failure" },
          },
        }),
      );
      return 1;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:queued-failure": {
        lifecycleRevision: "revision-queued-failure",
        sessionId: "queued-failure",
        updatedAt: now,
      },
    });
    mockGatewayMethods(mocks.callGateway, {
      agent: new Error("launch failed"),
    });

    hydrateAndActivateRegistry();

    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-queued-failure")).toMatchObject({
        execution: { status: "terminal" },
        collectorCompletion: { status: "failed" },
      }),
    );
    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:subagent:queued-failure",
            deleteTranscript: true,
          }),
        }),
      ),
    );
    await waitForFast(() =>
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:queued-failure",
          reason: "deleted",
        }),
      ),
    );
    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:queued-failure",
      reason: "delete",
      parentSessionKey: "agent:main:main",
    });
    expect(mod.getSubagentRunByRunId("run-queued-failure")).toMatchObject({
      collectorLaunchCleanupPending: false,
      contextEngineCleanupCompletedAt: expect.any(Number),
    });
    const contextEndCalls = mocks.onSubagentEnded.mock.calls.length;
    await mod.testing.sweepOnceForTests();
    expect(mocks.onSubagentEnded).toHaveBeenCalledTimes(contextEndCalls);
  });

  it("retries restored collector session cleanup before announcing deletion", async () => {
    const now = Date.now();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set(
        "run-queued-cleanup-retry",
        makeQueuedRun({
          runId: "run-queued-cleanup-retry",
          childSessionKey: "agent:main:subagent:queued-cleanup-retry",
          swarmRequesterSessionKey: "agent:main:main",
          task: "retry failed cleanup",
          groupId: "restore-cleanup-retry",
          createdAt: now,
          queuedLaunch: {
            request: { sessionKey: "agent:main:subagent:queued-cleanup-retry" },
          },
        }),
      );
      return 1;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:queued-cleanup-retry": {
        lifecycleRevision: "revision-queued-cleanup-retry",
        sessionId: "queued-cleanup-retry",
        updatedAt: now,
      },
    });
    let deleteAttempts = 0;
    let releaseDelete: (() => void) | undefined;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      if (request.method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete unavailable");
        }
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseDelete = () => resolve({});
        });
      }
      return {};
    });

    hydrateAndActivateRegistry();

    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "queued" },
      }),
    );
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(deleteAttempts).toBe(2);
    expect(mocks.emitSessionLifecycleEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
      }),
    );
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(
      mod.getSubagentRunByRunId("run-queued-cleanup-retry")?.collectorCompletion,
    ).toBeUndefined();

    releaseDelete?.();
    await waitForFast(() =>
      expect(mod.getSubagentRunByRunId("run-queued-cleanup-retry")).toMatchObject({
        execution: { status: "terminal" },
        collectorCompletion: { status: "failed" },
      }),
    );
    await waitForFast(() =>
      expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
        sessionKey: "agent:main:subagent:queued-cleanup-retry",
        reason: "delete",
        parentSessionKey: "agent:main:main",
      }),
    );
    await waitForFast(() =>
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith(
        expect.objectContaining({
          childSessionKey: "agent:main:subagent:queued-cleanup-retry",
          reason: "deleted",
        }),
      ),
    );
  });

  it("rolls back a queued collector failure when persistence fails", () => {
    const runId = "run-queued-persist-failure";
    mod.addSubagentRunForTests(
      makeQueuedRun({
        runId,
        childSessionKey: "agent:main:subagent:queued-persist-failure",
        task: "remain queued after sqlite failure",
        groupId: "persist-failure",
        createdAt: Date.now(),
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-persist-failure" },
        },
      }),
    );
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });

    expect(() => mod.testing.failQueuedSubagentRun(runId, "launch failed")).toThrow("sqlite busy");

    expect(mod.getSubagentRunByRunId(runId)).toMatchObject({
      execution: { status: "queued" },
      queuedLaunch: { maxConcurrent: 1 },
    });
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
    expect(mod.getSubagentRunByRunId(runId)?.execution.endedAt).toBeUndefined();
  });

  it("requeues durable requester-settle obligations after a worker error", async () => {
    const endedAt = Date.now() - 1_000;
    mod.addSubagentRunForTests({
      runId: "run-settle-retry",
      childSessionKey: "agent:main:subagent:settle-retry",
      task: "retry requester settle wake",
      expectsCompletionMessage: true,
      createdAt: endedAt - 1_000,
      endedAt,
      cleanupCompletedAt: endedAt,
      delivery: { status: "delivered" },
      requesterSettleWake: { status: "pending", attemptCount: 0 },
    });
    mocks.maybeWakeRequesterAfterAllChildrenSettled.mockRejectedValueOnce(new Error("sqlite busy"));

    await mod.testing.sweepOnceForTests();
    await waitForFast(() =>
      expect(mocks.maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledTimes(1),
    );
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    await mod.testing.sweepOnceForTests();
    await waitForFast(() =>
      expect(mocks.maybeWakeRequesterAfterAllChildrenSettled).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps runs active instead of terminally failing on recoverable wait transport errors", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": new Error("gateway closed (1006): transport close"),
    });

    mod.registerSubagentRun({
      runId: "run-interrupted-wait",
      task: "resume after transport close",
    });

    await waitForFast(() => expect(findRequesterRun("run-interrupted-wait")).toBeDefined());
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = findRequesterRun("run-interrupted-wait");
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
  });

  it("detaches subagent completion from a disposed requester transcript owner", async () => {
    const sessionKey = "agent:main:main";
    const activeGatewayContext = { recoveryRuntime } as never;
    mod.activateSubagentRegistry(
      () =>
        ({
          recoveryRuntime,
          resolveGatewayContext: () => activeGatewayContext,
        }) as never,
    );
    let disposed = false;
    let resolveWait: (value: Record<string, unknown>) => void = () => {};
    const pendingWait = new Promise<Record<string, unknown>>((resolve) => {
      resolveWait = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const freshCompletionWrite = vi.fn(async () => {});

    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method !== "agent.wait") {
        return {};
      }
      const result = await pendingWait;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshCompletionWrite);
      return result;
    });
    mocks.runSubagentAnnounceFlow.mockImplementation(async () => {
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
      return "delivered";
    });

    await withOwnedSessionTranscriptWrites(
      { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
      async () => {
        mod.registerSubagentRun({
          runId: "run-detached-requester-owner",
          requesterSessionKey: sessionKey,
          task: "finish after the requester attempt exits",
          expectsCompletionMessage: true,
        });
        await waitForFast(() =>
          expect(mocks.callGateway).toHaveBeenCalledWith(
            expect.objectContaining({ method: "agent.wait" }),
          ),
        );
      },
    );

    disposed = true;
    resolveWait({ status: "ok", startedAt: 111, endedAt: 222 });

    await waitForFast(() => expect(freshTranscriptWrite).toHaveBeenCalledOnce());
    expect(freshCompletionWrite).toHaveBeenCalledOnce();
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    const announceParams = (
      mocks.runSubagentAnnounceFlow.mock.calls as unknown as Array<
        [{ resolveGatewayContext?: () => unknown }]
      >
    )[0]?.[0];
    expect(announceParams?.resolveGatewayContext?.()).toBe(activeGatewayContext);
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
  });

  it("does not fall back to network recovery without an instance-bound runtime", async () => {
    mod.activateSubagentRegistry(() => undefined);

    mod.scheduleSubagentRegistrySweep({ delayMs: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
  });

  it("keeps a reserved recovery receipt reusable when its lifecycle retires", () => {
    const runId = "run-recovery-lifecycle-fence";
    const entry = createSubagentRunRecord({
      runId,
      task: "resume only in the owning Gateway lifecycle",
      execution: { status: "interrupted", startedAt: Date.now() - 25_000 },
    });
    const runs = new Map([[runId, entry]]);
    const persistOrThrow = vi.fn();
    const manager = createSubagentRunManager({
      runs,
      getRunsForChildSession: () => runs.values(),
      resumedRuns: new Set(),
      persist: vi.fn(),
      persistOrThrow,
      callGateway: mocks.callGateway as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: mocks.getRuntimeConfig,
      ensureListener: noop,
      startSweeper: noop,
      stopSweeper: noop,
      resumeSubagentRun: noop,
      clearPendingLifecycleError: noop,
      clearPendingLifecycleTimeout: noop,
      resolveSubagentWaitTimeoutMs: () => 1_000,
      scheduleSweep: noop,
      resolveSubagentSessionCompletion: () => null,
      resolveSubagentSessionStartedAt: () => undefined,
      notifyContextEngineSubagentEnded: async () => {},
      completeCleanupBookkeeping: noop,
      completeSubagentRun: async () => {},
      resolveSubagentTask: () => ({ lookup: "unavailable" }),
    });
    const idempotencyKey = "subagent-recovery:lifecycle-fence";
    expect(
      manager.reserveSubagentRestartRecoveryLaunch({
        runId,
        expected: entry,
        sessionId: "session-id",
        sessionMarker: "session-id:333",
        idempotencyKey,
      }),
    ).toBe(idempotencyKey);
    const reserved = entry.execution.restartRecovery;
    expect(reserved).toMatchObject({ phase: "reserved" });
    expect(reserved).not.toHaveProperty("lifecycleGeneration");

    mocks.lifecycleGeneration = "retired-generation";
    expect(
      manager.markSubagentRestartRecoveryLaunchAttempted({
        runId,
        expected: entry,
        sessionMarker: "session-id:333",
        idempotencyKey,
        lifecycleGeneration: "test-generation",
      }),
    ).toBeUndefined();
    expect(entry.execution.restartRecovery).toBe(reserved);
    expect(persistOrThrow).toHaveBeenCalledOnce();

    expect(
      manager.markSubagentRestartRecoveryLaunchAttempted({
        runId,
        expected: entry,
        sessionMarker: "session-id:333",
        idempotencyKey,
        lifecycleGeneration: "retired-generation",
      }),
    ).toMatchObject({ phase: "attempted", idempotencyKey });
    expect(persistOrThrow).toHaveBeenCalledTimes(2);
  });

  it("keeps parent run active when agent.wait times out before child session settles", async () => {
    let waitAttempts = 0;
    let resolveSecondWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
    }) => void = () => {};
    const secondWait = new Promise<{ status: "ok"; startedAt: number; endedAt: number }>(
      (resolve) => {
        resolveSecondWait = resolve;
      },
    );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait;
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        status: "running",
      }),
    );

    mod.registerSubagentRun({
      runId: "run-waiter-timeout",
      task: "eventually complete",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = findRequesterRun("run-waiter-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();

    resolveSecondWait({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-waiter-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.execution.endedAt).toBe(222);
      expectRecordFields(
        completedRun?.execution.outcome,
        { status: "ok" },
        "completed run outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("terminally times out explicit runTimeoutSeconds when agent.wait has no terminal snapshot", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: startedAt,
        status: "running",
      }),
    );

    mod.registerSubagentRun({
      runId: "run-explicit-timeout",
      task: "respect explicit timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    const activeRun = findRequesterRun("run-explicit-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-explicit-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "explicit run timeout outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    {
      name: "keeps explicit run timeout terminal when late lifecycle success arrives",
      runId: "run-timeout-late-lifecycle-ok",
      task: "timeout should stay terminal",
      eventStartedAfterMs: undefined,
      eventEndedAfterMs: 2_000,
      expectCapturedReply: false,
    },
    {
      name: "keeps published explicit timeout stable when pre-deadline lifecycle success arrives late",
      runId: "run-timeout-late-lifecycle-predeadline-ok",
      task: "published timeout should stay stable",
      eventStartedAfterMs: 10,
      eventEndedAfterMs: 500,
      expectCapturedReply: true,
    },
  ])(
    "$name",
    async ({ runId, task, eventStartedAfterMs, eventEndedAfterMs, expectCapturedReply }) => {
      const startedAt = Date.now();
      mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "timeout" } });
      mocks.loadSessionStore.mockReturnValue(
        createSessionStore({ updatedAt: startedAt, status: "running" }),
      );
      mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 1 });

      await vi.advanceTimersByTimeAsync(5_000);
      await waitForFast(() => {
        expect(findRequesterRun(runId)).toMatchObject({
          execution: {
            status: "terminal",
            endedAt: startedAt + 1_000,
            outcome: { status: "timeout" },
          },
        });
      });
      getLifecycleHandler()({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          ...(eventStartedAfterMs === undefined
            ? {}
            : { startedAt: startedAt + eventStartedAfterMs }),
          endedAt: startedAt + eventEndedAfterMs,
        },
      });
      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(startedAt + 1_000);
        expectRecordFields(run?.execution.outcome, {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        });
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      });
      if (expectCapturedReply) {
        expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("converts first lifecycle success after the explicit run deadline into timeout", async () => {
    const startedAt = Date.now();
    mockPendingAgentWait();

    mod.registerSubagentRun({
      runId: "run-lifecycle-success-after-deadline",
      task: "post-deadline lifecycle success should timeout",
      runTimeoutSeconds: 1,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-lifecycle-success-after-deadline",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 2_000,
      },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-lifecycle-success-after-deadline");
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "late first lifecycle timeout outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("uses observed lifecycle start time when applying explicit run deadline", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt);
    mockPendingAgentWait();

    mod.registerSubagentRun({
      runId: "run-lifecycle-observed-start",
      task: "respect observed lifecycle start",
      runTimeoutSeconds: 60,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-lifecycle-observed-start",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: observedStartedAt,
        endedAt: createdAt + 65_000,
      },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-lifecycle-observed-start");
      expect(run?.execution.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "ok",
          startedAt: observedStartedAt,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "observed lifecycle start success outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps in-flight explicit deadline timeout stable during cleanup", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    mod.registerSubagentRun({
      runId: "run-cleanup-lock-observed-success",
      task: "cleanup lock should not freeze stale timeout",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      createdAt,
      sessionStartedAt: createdAt,
      execution: {
        status: "terminal",
        startedAt: createdAt,
        endedAt: createdAt + 60_000,
        outcome: {
          status: "timeout",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          elapsedMs: 60_000,
        },
      },
      cleanupHandled: true,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-cleanup-lock-observed-success",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
      },
    });

    await waitForFast(() => {
      const correctedRun = findRequesterRun("run-cleanup-lock-observed-success");
      expect(correctedRun?.execution.endedAt).toBe(createdAt + 60_000);
      expectRecordFields(
        correctedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          elapsedMs: 60_000,
        },
        "in-flight cleanup timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("refreshes unpublished timeout delivery payloads after lifecycle correction", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    mockPendingAgentWait();
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce("retryable");
    mod.registerSubagentRun({
      runId: "run-refresh-pending-timeout-payload",
      task: "pending timeout payload should refresh",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      createdAt,
      sessionStartedAt: createdAt,
      execution: {
        status: "terminal",
        startedAt: createdAt,
        endedAt: createdAt + 60_000,
        outcome: {
          status: "timeout",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          elapsedMs: 60_000,
        },
      },
      delivery: {
        status: "pending",
        payload: {
          requesterSessionKey: "agent:main:main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-refresh-pending-timeout-payload",
          task: "pending timeout payload should refresh",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          outcome: { status: "timeout" },
        },
      },
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-refresh-pending-timeout-payload",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: createdAt + 10_000,
        endedAt: createdAt + 65_000,
      },
    });

    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "refreshed pending delivery announce",
        (record) => record.childRunId === "run-refresh-pending-timeout-payload",
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "ok",
          startedAt: createdAt + 10_000,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "refreshed pending delivery outcome",
      );
    });
  });

  it.each([
    {
      name: "allows non-explicit published timeouts to be corrected by lifecycle success",
      runId: "run-non-explicit-timeout-corrected",
      task: "non-explicit timeout remains correctable",
      runTimeoutSeconds: undefined,
    },
    {
      name: "allows pre-deadline lifecycle timeouts to be corrected by lifecycle success",
      runId: "run-predeadline-timeout-corrected",
      task: "pre-deadline timeout remains correctable",
      runTimeoutSeconds: 60,
    },
  ])("$name", async ({ runId, task, runTimeoutSeconds }) => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    mod.registerSubagentRun({
      runId,
      task,
      ...(runTimeoutSeconds === undefined ? {} : { runTimeoutSeconds }),
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      startedAt,
      sessionStartedAt: startedAt,
      endedAt: startedAt + 30_000,
      outcome: { status: "timeout", startedAt, endedAt: startedAt + 30_000, elapsedMs: 30_000 },
      delivery: {
        status: "delivered",
        announcedAt: startedAt + 30_000,
        deliveredAt: startedAt + 30_000,
      },
    });
    getLifecycleHandler()({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt, endedAt: startedAt + 35_000 },
    });
    await waitForFast(() => {
      const correctedRun = findRequesterRun(runId);
      expect(correctedRun?.execution.endedAt).toBe(startedAt + 35_000);
      expectRecordFields(correctedRun?.execution.outcome, {
        status: "ok",
        startedAt,
        endedAt: startedAt + 35_000,
        elapsedMs: 35_000,
      });
    });
  });

  it("caps lifecycle timeout events to the explicit run deadline", async () => {
    const startedAt = Date.now();
    mockPendingAgentWait();

    mod.registerSubagentRun({
      runId: "run-lifecycle-timeout-after-deadline",
      task: "post-deadline lifecycle timeout should cap",
      runTimeoutSeconds: 1,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-lifecycle-timeout-after-deadline",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 2_000,
        aborted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await waitForFast(() => {
      const run = findRequesterRun("run-lifecycle-timeout-after-deadline");
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "capped lifecycle timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("keeps published explicit timeout stable when late lifecycle timeout arrives", async () => {
    const startedAt = Date.now();
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": { status: "timeout" },
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: startedAt,
        status: "running",
      }),
    );

    mod.registerSubagentRun({
      runId: "run-timeout-late-lifecycle-timeout",
      task: "published timeout should ignore late timeout",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expect(completedRun?.execution.outcome?.status).toBe("timeout");
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-timeout-late-lifecycle-timeout",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: startedAt + 10,
        endedAt: startedAt + 2_000,
        aborted: true,
      },
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await waitForFast(() => {
      const run = findRequesterRun("run-timeout-late-lifecycle-timeout");
      expect(run?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "stable published lifecycle timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("treats boundary agent.wait timeouts as explicit run timeouts before child abort errors win", async () => {
    const startedAt = Date.now();
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        vi.setSystemTime(startedAt + 999);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: startedAt,
        status: "running",
      }),
    );

    mod.registerSubagentRun({
      runId: "run-boundary-timeout",
      task: "deadline skew should still timeout",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-boundary-timeout");
      expect(waitAttempts).toBe(1);
      expect(completedRun?.execution.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "boundary explicit run timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "prefers explicit run timeout over late restored agent.wait success",
      runId: "run-resumed-late-success",
      task: "resume after explicit timeout",
      waitStartedAfterMs: 0,
      waitEndedAfterMs: 61_000,
      expected: { status: "timeout", startedAfterMs: 0, endedAfterMs: 60_000, elapsedMs: 60_000 },
      label: "late restored wait success timeout outcome",
    },
    {
      name: "uses observed agent.wait start time when applying explicit run deadline",
      runId: "run-resumed-observed-start",
      task: "respect observed start",
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 65_000,
      expected: { status: "ok", startedAfterMs: 10_000, endedAfterMs: 65_000, elapsedMs: 55_000 },
      label: "observed start success outcome",
    },
  ] as const)(
    "$name",
    async ({ runId, task, waitStartedAfterMs, waitEndedAfterMs, expected, label }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      vi.setSystemTime(createdAt + waitEndedAfterMs);
      mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
      mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
        runs: Map<string, unknown>;
        mergeOnly?: boolean;
      }) => {
        params.runs.set(
          runId,
          createSubagentRunRecord({
            runId,
            task,
            runTimeoutSeconds: 60,
            createdAt,
            startedAt: createdAt,
            sessionStartedAt: createdAt,
          }),
        );
        return 1;
      }) as never);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: createdAt + waitStartedAfterMs,
          endedAt: createdAt + waitEndedAfterMs,
        },
      });

      hydrateAndActivateRegistry();

      await waitForFast(() => {
        const completedRun = findRequesterRun(runId);
        expect(completedRun?.execution.endedAt).toBe(createdAt + expected.endedAfterMs);
        expectRecordFields(
          completedRun?.execution.outcome,
          {
            status: expected.status,
            startedAt: createdAt + expected.startedAfterMs,
            endedAt: createdAt + expected.endedAfterMs,
            elapsedMs: expected.elapsedMs,
          },
          label,
        );
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("uses session-store start time for successful agent.wait results without a start", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        vi.setSystemTime(createdAt + 65_000);
        return {
          status: "ok",
          endedAt: createdAt + 65_000,
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        status: "done",
        startedAt: sessionStartedAt,
        updatedAt: createdAt + 65_000,
        endedAt: createdAt + 65_000,
      }),
    );

    mod.registerSubagentRun({
      runId: "run-ok-session-store-start",
      task: "respect restored success start",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const completedRun = findRequesterRun("run-ok-session-store-start");
      expect(completedRun?.execution.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "ok",
          startedAt: sessionStartedAt,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "restored wait success uses session store start",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "does not terminally time out plain agent.wait timeouts before the observed run deadline",
      runId: "run-plain-timeout-observed-start",
      task: "do not timeout before observed start deadline",
      initialNowAfterMs: 61_000,
      waitStartedAfterMs: 10_000,
      sessionStartedAfterMs: undefined,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 0,
      advanceOnFirstWait: false,
      label: "observed start plain wait timeout outcome",
    },
    {
      name: "uses running session-store start time for plain agent.wait timeouts",
      runId: "run-plain-timeout-session-store-start",
      task: "do not timeout before session store start deadline",
      initialNowAfterMs: 0,
      waitStartedAfterMs: undefined,
      sessionStartedAfterMs: 10_000,
      observedStartedAfterMs: 10_000,
      sessionUpdatedAfterMs: 61_000,
      advanceOnFirstWait: true,
      label: "session store start plain wait timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      waitStartedAfterMs,
      sessionStartedAfterMs,
      observedStartedAfterMs,
      sessionUpdatedAfterMs,
      advanceOnFirstWait,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const observedStartedAt = createdAt + observedStartedAfterMs;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      let waitAttempts = 0;
      mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
        if (request.method !== "agent.wait") {
          return {};
        }
        waitAttempts += 1;
        if (advanceOnFirstWait && waitAttempts === 1) {
          vi.setSystemTime(createdAt + 61_000);
        }
        return {
          status: "timeout",
          ...(waitStartedAfterMs === undefined
            ? {}
            : { startedAt: createdAt + waitStartedAfterMs }),
        };
      });
      mocks.loadSessionStore.mockReturnValue(
        createSessionStore({
          status: "running",
          updatedAt: createdAt + sessionUpdatedAfterMs,
          ...(sessionStartedAfterMs === undefined
            ? {}
            : { startedAt: createdAt + sessionStartedAfterMs }),
        }),
      );

      mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 60 });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(waitAttempts).toBeGreaterThanOrEqual(1);
        expect(run?.execution.endedAt).toBeUndefined();
        expect(run?.execution.outcome).toBeUndefined();
        expect(run?.execution.startedAt).toBe(observedStartedAt);
      });

      vi.setSystemTime(observedStartedAt + 60_000);
      await vi.advanceTimersByTimeAsync(5_000);

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(observedStartedAt + 60_000);
        expectRecordFields(
          run?.execution.outcome,
          {
            status: "timeout",
            startedAt: observedStartedAt,
            endedAt: observedStartedAt + 60_000,
            elapsedMs: 60_000,
          },
          label,
        );
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "prefers agent.wait start time over stale session-store start time",
      runId: "run-wait-start-over-session-store-start",
      task: "prefer wait observed start",
      initialNowMs: 61_000,
      waitStartedAtMs: 10_000,
      sessionStartedAtMs: 0,
      sessionEndedAtMs: 65_000,
      expected: { status: "ok", startedAtMs: 10_000, endedAtMs: 65_000, elapsedMs: 55_000 },
      label: "wait observed start beats stale session store start",
    },
    {
      name: "uses session-store start time when agent.wait times out without a start",
      runId: "run-session-store-start-after-wait-timeout",
      task: "use session store observed start",
      initialNowMs: 0,
      waitNowMs: 61_000,
      sessionStartedAtMs: 10_000,
      sessionEndedAtMs: 65_000,
      expected: { status: "ok", startedAtMs: 10_000, endedAtMs: 65_000, elapsedMs: 55_000 },
      label: "session store observed start beats stale registry start",
    },
    {
      name: "ignores stale session-store start time for fresh terminal completions",
      runId: "run-ignore-stale-session-start",
      task: "ignore stale session store start",
      initialNowMs: 0,
      waitNowMs: 61_000,
      sessionStartedAtMs: -60_000,
      sessionEndedAtMs: 30_000,
      expected: { status: "ok", startedAtMs: 0, endedAtMs: 30_000, elapsedMs: 30_000 },
      label: "fresh terminal completion ignores stale session start",
    },
    {
      name: "applies explicit timeout to terminal session rows without startedAt",
      runId: "run-session-row-no-start-timeout",
      task: "terminal row without start still honors timeout",
      initialNowMs: 0,
      waitNowMs: 61_000,
      sessionEndedAtMs: 61_000,
      expected: { status: "timeout", startedAtMs: 0, endedAtMs: 60_000, elapsedMs: 60_000 },
      label: "terminal session row without start timeout outcome",
    },
  ])(
    "$name",
    async ({
      runId,
      task,
      initialNowMs,
      waitNowMs,
      waitStartedAtMs,
      sessionStartedAtMs,
      sessionEndedAtMs,
      expected,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T12:00:00Z");
      vi.setSystemTime(createdAt + initialNowMs);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": () => {
          if (waitNowMs !== undefined) {
            vi.setSystemTime(createdAt + waitNowMs);
          }
          return {
            status: "timeout",
            ...(waitStartedAtMs === undefined ? {} : { startedAt: createdAt + waitStartedAtMs }),
          };
        },
      });
      mocks.loadSessionStore.mockReturnValue(
        createSessionStore({
          status: "done",
          ...(sessionStartedAtMs === undefined
            ? {}
            : { startedAt: createdAt + sessionStartedAtMs }),
          updatedAt: createdAt + sessionEndedAtMs,
          endedAt: createdAt + sessionEndedAtMs,
        }),
      );

      mod.registerSubagentRun({ runId, task, runTimeoutSeconds: 60 });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(createdAt + expected.endedAtMs);
        expectRecordFields(
          run?.execution.outcome,
          {
            status: expected.status,
            startedAt: createdAt + expected.startedAtMs,
            endedAt: createdAt + expected.endedAtMs,
            elapsedMs: expected.elapsedMs,
          },
          label,
        );
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("caps restored waits to the remaining explicit run timeout", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    const runTimeoutSeconds = 60;
    vi.setSystemTime(startedAt + 59_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set(
        "run-resumed-near-deadline",
        createSubagentRunRecord({
          runId: "run-resumed-near-deadline",
          task: "resume near explicit timeout",
          runTimeoutSeconds,
          createdAt: startedAt,
          startedAt,
          sessionStartedAt: startedAt,
        }),
      );
      return 1;
    }) as never);
    const waitTimeouts: unknown[] = [];
    mocks.callGateway.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        if (request.method === "agent.wait") {
          waitTimeouts.push(request.params?.timeoutMs);
          vi.setSystemTime(startedAt + 60_000);
          return { status: "timeout" };
        }
        return {};
      },
    );

    hydrateAndActivateRegistry();

    await waitForFast(() => {
      expect(waitTimeouts).toEqual([1_000]);
      const completedRun = findRequesterRun("run-resumed-near-deadline");
      expect(completedRun?.execution.endedAt).toBe(startedAt + 60_000);
      expectRecordFields(
        completedRun?.execution.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 60_000,
          elapsedMs: 60_000,
        },
        "restored explicit run timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "cancellation", status: "timeout" as const, stopReason: "rpc" },
    { label: "supersession", status: "error" as const, stopReason: "superseded" },
  ])("records explicit agent.wait $label without retrying", async ({ status, stopReason }) => {
    const runId = `run-terminal-${stopReason}`;
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status,
        startedAt: 111,
        endedAt: 222,
        stopReason,
      },
    });
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        status: "running",
      }),
    );

    mod.registerSubagentRun({
      runId,
      task: "terminate without retrying",
    });

    // Main defers timed-out lifecycle completion behind a retry grace timer.
    await vi.advanceTimersByTimeAsync(20_000);

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run?.execution.endedAt).toBe(222);
      expectRecordFields(
        run?.execution.outcome,
        { status: "error", error: "subagent run terminated" },
        "terminal cancellation outcome",
      );
    });
    // Announce delivery for wait-terminal completions is owned by main's
    // cancellation-evidence reconciliation and covered by its own flows;
    // this test pins the audit-relevant ordering (outcome + endedAt) only.
  });

  it.each([
    {
      name: "caps terminal agent.wait timeouts to the explicit run deadline",
      runId: "run-terminal-timeout-capped",
      task: "cap terminal timeout",
      initialNowAfterMs: 60_000,
      waitStartedAfterMs: 60_000,
      waitEndedAfterMs: 62_000,
      sessionUpdatedAfterMs: 60_000,
      runTimeoutSeconds: 1,
      label: "capped terminal timeout outcome",
    },
    {
      name: "uses observed agent.wait start time when capping terminal timeout",
      runId: "run-terminal-timeout-observed-start",
      task: "cap timeout using observed start",
      initialNowAfterMs: 75_000,
      waitStartedAfterMs: 10_000,
      waitEndedAfterMs: 75_000,
      sessionUpdatedAfterMs: 0,
      runTimeoutSeconds: 60,
      label: "observed start capped terminal timeout outcome",
    },
  ] as const)(
    "$name",
    async ({
      runId,
      task,
      initialNowAfterMs,
      waitStartedAfterMs,
      waitEndedAfterMs,
      sessionUpdatedAfterMs,
      runTimeoutSeconds,
      label,
    }) => {
      const createdAt = Date.parse("2026-03-24T11:59:00Z");
      const startedAt = createdAt + waitStartedAfterMs;
      const elapsedMs = runTimeoutSeconds * 1_000;
      vi.setSystemTime(createdAt + initialNowAfterMs);
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "timeout",
          startedAt,
          endedAt: createdAt + waitEndedAfterMs,
          stopReason: "rpc",
        },
      });
      mocks.loadSessionStore.mockReturnValue(
        createSessionStore({
          updatedAt: createdAt + sessionUpdatedAfterMs,
          status: "running",
        }),
      );

      mod.registerSubagentRun({ runId, task, runTimeoutSeconds });

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run?.execution.endedAt).toBe(startedAt + elapsedMs);
        expectRecordFields(
          run?.execution.outcome,
          { status: "timeout", startedAt, endedAt: startedAt + elapsedMs, elapsedMs },
          label,
        );
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores stale terminal session-store rows from older child runs", async () => {
    let waitAttempts = 0;
    let resolveSecondWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
    }) => void = () => {};
    const secondWait = new Promise<{ status: "ok"; startedAt: number; endedAt: number }>(
      (resolve) => {
        resolveSecondWait = resolve;
      },
    );
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          return { status: "timeout" };
        }
        return secondWait;
      }
      return {};
    });
    const staleEndedAt = Date.parse("2026-03-24T11:59:00Z");
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: staleEndedAt,
        status: "done",
        startedAt: staleEndedAt - 100,
        endedAt: staleEndedAt,
      }),
    );

    mod.registerSubagentRun({
      runId: "run-reactivated-timeout",
      task: "new run after stale terminal row",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = findRequesterRun("run-reactivated-timeout");
    expect(activeRun?.execution.endedAt).toBeUndefined();
    expect(activeRun?.execution.outcome).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resolveSecondWait({
      status: "ok",
      startedAt: Date.parse("2026-03-24T12:00:01Z"),
      endedAt: Date.parse("2026-03-24T12:00:02Z"),
    });
    await waitForFast(() => {
      const completedRun = findRequesterRun("run-reactivated-timeout");
      expectRecordFields(
        completedRun?.execution.outcome,
        { status: "ok" },
        "reactivated run outcome",
      );
    });
  });

  it("keeps sessions_yield-ended subagent runs paused instead of announcing no output", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
        stopReason: "end_turn",
        livenessState: "paused",
        yielded: true,
      },
    });

    mod.registerSubagentRun({
      runId: "run-yield-paused",
      task: "wait for child continuation",
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-yield-paused");
      expect(run?.execution.endedAt).toBe(222);
      expect(run?.pauseReason).toBe("sessions_yield");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(countPendingDescendantRuns("agent:main:main")).toBe(1);

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-yield-paused",
        nextRunId: "run-yield-continuation",
      }),
    ).toBe(true);
    const replacement = findRequesterRun("run-yield-continuation");
    expect(replacement?.runId).toBe("run-yield-continuation");
    expect(replacement?.pauseReason).toBeUndefined();
    expect(replacement?.execution.endedAt).toBeUndefined();
    // The operator is the live audience for a steer, so the requester wake
    // credential is intentionally dropped rather than re-armed.
    expect(replacement?.requesterSettleWake).toBeUndefined();
  });

  describe("sessions_yield follow-up adoption", () => {
    const CHILD_SESSION_KEY = "agent:main:subagent:yield-followup";
    const PAUSED_RUN_ID = "run-yield-followup-paused";
    const FOLLOW_UP_RUN_ID = "run-yield-followup-continued";
    const SIBLING_RUN_ID = "run-yield-followup-sibling";

    /**
     * Drives a child run to the paused state a `sessions_yield` produces, then
     * arms the wake credential that `settleRequesterTurnAfterSessionSpawns`
     * writes when the parent yields behind its own spawn batch.
     */
    const arrangePausedChildWithYieldedRequester = async () => {
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          stopReason: "end_turn",
          livenessState: "paused",
          yielded: true,
        },
      });
      mod.registerSubagentRun({
        runId: PAUSED_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        task: "wait for the remote job",
      });
      const paused = await waitForFast(() => {
        const run = expectDefined(findRequesterRun(PAUSED_RUN_ID), "paused subagent run");
        expect(run.pauseReason).toBe("sessions_yield");
        return run;
      });
      paused.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
        batchRunIds: [SIBLING_RUN_ID, PAUSED_RUN_ID].toSorted(),
      };
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      return paused;
    };

    it("announces to the original requester once the adopted follow-up ends normally", async () => {
      await arrangePausedChildWithYieldedRequester();

      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 333,
          endedAt: 444,
          stopReason: "end_turn",
        },
      });
      expect(
        mod.adoptPausedSubagentRunForFollowUp({
          childSessionKey: CHILD_SESSION_KEY,
          runId: FOLLOW_UP_RUN_ID,
          task: "the remote job finished",
        }),
      ).toBe(true);

      expect(findRequesterRun(PAUSED_RUN_ID)).toBeUndefined();
      const adopted = expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run");
      // Adoption continues the same unit of work: the requester identity that
      // spawned the paused run must survive, or the announce lands on the
      // child's own session instead of the waiting parent.
      expect(adopted.requesterSessionKey).toBe("agent:main:main");
      expect(adopted.task).toBe("the remote job finished");
      expect(adopted.pauseReason).toBeUndefined();
      // The frozen batch is addressed by runId, so the retired id must be
      // remapped or this row drops out of the batch it still gates.
      expect(adopted.requesterSettleWake?.batchRunIds).toEqual(
        [SIBLING_RUN_ID, FOLLOW_UP_RUN_ID].toSorted(),
      );
      expect(adopted.requesterSettleWake).toMatchObject({
        requesterYieldBatch: true,
        rearmGeneration: 1,
      });

      await waitForFast(() => {
        expect(
          expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run").execution
            .endedAt,
        ).toBe(444);
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalled();
      });
    });

    it("stays paused without announcing when the adopted follow-up yields again", async () => {
      await arrangePausedChildWithYieldedRequester();

      expect(
        mod.adoptPausedSubagentRunForFollowUp({
          childSessionKey: CHILD_SESSION_KEY,
          runId: FOLLOW_UP_RUN_ID,
          task: "still waiting on the remote job",
        }),
      ).toBe(true);

      await waitForFast(() => {
        const adopted = expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run");
        expect(adopted.pauseReason).toBe("sessions_yield");
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      // A yielded row is still unsettled work, so the parent's batch keeps
      // deferring instead of waking on a run that has not produced a result.
      expect(countPendingDescendantRuns("agent:main:main")).toBe(1);
    });
  });

  it("ignores a late yield lifecycle event after the paused run is killed", async () => {
    mockPendingAgentWait();
    const runId = "run-yield-killed-before-late-event";
    const childSessionKey = "agent:main:subagent:yield-killed-before-late-event";
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      task: "stop while paused",
    });
    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, yielded: true },
    });
    expect(mod.markSubagentRunTerminated({ runId, childSessionKey, reason: "killed" })).toBe(1);
    const killed = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((run) => run.runId === runId);
    expect(killed).toMatchObject({
      execution: { status: "terminal", endedAt: 222 },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      suppressAnnounceReason: "killed",
    });
    expect(killed?.pauseReason).toBeUndefined();
    const killedCleanupAt = killed?.cleanupCompletedAt;

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
    });

    const afterLateYield = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((run) => run.runId === runId);
    expect(afterLateYield).toMatchObject({
      execution: { status: "terminal", endedAt: 222 },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      cleanupCompletedAt: killedCleanupAt,
      suppressAnnounceReason: "killed",
    });
    expect(afterLateYield?.pauseReason).toBeUndefined();
  });

  it("accepts an authoritative late yield after non-kill cleanup started", async () => {
    mockPendingAgentWait();
    const runId = "run-yield-after-success-cleanup";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:yield-after-success-cleanup",
      task: "pause after terminal projection",
    });
    const lifecycleHandler = getLifecycleHandler();
    const run = findRequesterRun(runId);
    expect(run).toBeDefined();
    Object.assign(run!, {
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      execution: {
        ...run!.execution,
        status: "terminal",
        endedAt: 222,
        outcome: { status: "ok" as const },
      },
      cleanupHandled: true,
      cleanupCompletedAt: 223,
      delivery: { status: "delivered" as const, deliveredAt: 223 },
    });

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
    });

    expect(run).toMatchObject({
      execution: { status: "terminal", endedAt: 333 },
      pauseReason: "sessions_yield",
      cleanupHandled: false,
      delivery: { status: "pending" },
    });
    expect(run?.endedReason).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
    expect(run?.cleanupCompletedAt).toBeUndefined();
  });

  it("keeps yield terminals paused when the lifecycle event also signals abort (#92448)", async () => {
    // sessions_yield ends the turn by aborting the run signal, so a depth-1
    // subagent's yield terminal can arrive carrying yielded plus aborted (or
    // stopReason="aborted"). The event handler must still pause the run, not
    // settle it `cancelled` and deliver a false notice to the requester.
    mockPendingAgentWait();

    const cases = [
      { runId: "run-yield-stopreason-aborted", extra: { stopReason: "aborted" } },
      { runId: "run-yield-aborted-flag", extra: { aborted: true } },
    ];

    for (const testCase of cases) {
      mod.registerSubagentRun({
        runId: testCase.runId,
        childSessionKey: `agent:main:subagent:${testCase.runId}`,
        task: "wait for child continuation",
      });

      const lifecycleHandler = getLifecycleHandler();

      lifecycleHandler?.({
        runId: testCase.runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 111,
          endedAt: 222,
          yielded: true,
          ...testCase.extra,
        },
      });

      await waitForFast(() => {
        const run = findRequesterRun(testCase.runId);
        expect(run?.pauseReason).toBe("sessions_yield");
        expect(run?.execution.outcome?.status).not.toBe("error");
      });
    }

    // Paused, never killed → no farewell/cancellation notice reaches the requester.
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending grace timer when a yield follows an intermediate aborted terminal (#92448)", async () => {
    // An earlier aborted terminal schedules a deferred kill grace timer; a
    // following yield must clear it, or it fires and settles the now-paused run.
    mockPendingAgentWait();

    mod.registerSubagentRun({
      runId: "run-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-timeout",
      task: "wait for child continuation",
    });

    const lifecycleHandler = getLifecycleHandler();

    // Intermediate aborted terminal → schedules the deferred kill grace timer.
    lifecycleHandler?.({
      runId: "run-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    // Yield terminal → must pause and cancel the pending grace timer.
    lifecycleHandler?.({
      runId: "run-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    // Advancing well past the 15s grace window must not undo the pause.
    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun("run-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.execution.outcome?.status).not.toBe("error");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending timeout grace timer when the run is explicitly killed", async () => {
    mockPendingAgentWait();
    const runId = "run-killed-after-pending-timeout";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:killed-after-pending-timeout",
      task: "stop during timeout grace",
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun(runId);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: { outcome: { status: "error", error: "manual kill" } },
    });
    expect(run?.execution.outcome?.status).not.toBe("timeout");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending grace timer when agent.wait observes the yield after an aborted terminal (#92448)", async () => {
    let resolveWait: (value: {
      status: "ok";
      startedAt: number;
      endedAt: number;
      yielded: true;
    }) => void = () => {};
    const waitResult = new Promise<{
      status: "ok";
      startedAt: number;
      endedAt: number;
      yielded: true;
    }>((resolve) => {
      resolveWait = resolve;
    });
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": waitResult,
    });

    mod.registerSubagentRun({
      runId: "run-wait-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-wait-timeout",
      task: "wait for child continuation through wait",
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-wait-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    resolveWait({ status: "ok", startedAt: 111, endedAt: 333, yielded: true });

    await waitForFast(() => {
      const run = findRequesterRun("run-wait-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const run = findRequesterRun("run-wait-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.execution.outcome?.status).not.toBe("timeout");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "announces blocked agent.wait snapshots as errors instead of success",
      runId: "run-blocked-wait",
      task: "overflow wait",
      wait: {
        status: "ok",
        error: "Context overflow: prompt too large for the model.",
      },
      expectedOutcome: {
        status: "error",
        error: "Context overflow: prompt too large for the model.",
      },
      expectedReason: "subagent-error",
      label: "blocked wait announce",
    },
    {
      name: "announces provider hard timeout wait snapshots as timeouts despite blocked metadata",
      runId: "run-blocked-hard-timeout-wait",
      task: "provider timeout wait",
      wait: {
        status: "error",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
      },
      expectedOutcome: { status: "timeout" },
      expectedReason: "subagent-complete",
      label: "hard timeout wait announce",
    },
  ] as const)("$name", async ({ runId, task, wait, expectedOutcome, expectedReason, label }) => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        startedAt: 100,
        endedAt: 250,
        livenessState: "blocked",
        ...wait,
      },
    });

    mod.registerSubagentRun({ runId, task, expectsCompletionMessage: true });

    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, label),
      { childRunId: runId },
      `${label} params`,
    );
    expectRecordFields(
      announceParams.outcome,
      { ...expectedOutcome, startedAt: 100, endedAt: 250, elapsedMs: 150 },
      `${label} outcome`,
    );

    const run = findRequesterRun(runId);
    expect(run?.endedReason).toBe(expectedReason);
    expect(run?.execution.outcome?.status).toBe(expectedOutcome.status);
  });

  it("carries producer reply evidence through a provider hard-timeout wait", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "error",
        startedAt: 100,
        endedAt: 250,
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
        terminalReply: { disposition: "empty" },
      },
    });

    mod.registerSubagentRun({
      runId: "run-hard-timeout-terminal-reply",
      task: "provider timeout reply evidence",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    expect(getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "timeout announce")).toMatchObject({
      childRunId: "run-hard-timeout-terminal-reply",
      outcome: { status: "timeout" },
      terminalReply: { disposition: "empty" },
    });
    expect(findRequesterRun("run-hard-timeout-terminal-reply")?.completion).toMatchObject({
      terminalReply: { disposition: "empty" },
      resultText: null,
    });
  });

  it("publishes aborted agent.wait snapshots only after killed reconciliation", async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 100,
        endedAt: 250,
        stopReason: "aborted",
      },
    });

    mod.registerSubagentRun({
      runId: "run-aborted-wait",
      task: "aborted wait",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-aborted-wait");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted wait announce"),
      { childRunId: "run-aborted-wait" },
      "aborted wait announce params",
    );
    expectRecordFields(
      announceParams.outcome,
      {
        status: "error",
        error: "subagent run terminated",
        startedAt: 100,
        endedAt: 250,
        elapsedMs: 150,
      },
      "aborted wait announce outcome",
    );

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-aborted-wait"),
      ).toBe(false);
    });
  });

  it("reconciles stale active runs from persisted terminal session state during sweep", async () => {
    mockPendingAgentWait();
    const persistedStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const persistedEndedAt = persistedStartedAt + 111;
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: persistedEndedAt,
        status: "done",
        startedAt: persistedStartedAt,
        endedAt: persistedEndedAt,
        runtimeMs: 111,
      }),
    );

    vi.setSystemTime(persistedStartedAt - 1);
    mod.registerSubagentRun({
      runId: "run-stale-terminal",
      task: "settle from persisted terminal state",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "stale terminal announce",
        (record) => record.childRunId === "run-stale-terminal",
      );
      expectRecordFields(
        announceParams,
        { childRunId: "run-stale-terminal" },
        "stale terminal announce",
      );
      expectRecordFields(
        announceParams.outcome,
        { status: "ok", endedAt: persistedEndedAt },
        "stale terminal announce outcome",
      );
    });

    const run = findRequesterRun("run-stale-terminal");
    expect(run?.execution.endedAt).toBe(persistedEndedAt);
    expectRecordFields(
      run?.execution.outcome,
      {
        status: "ok",
        endedAt: persistedEndedAt,
      },
      "stale terminal run outcome",
    );
    await waitForFast(() => expect(run?.cleanupCompletedAt).toBeTypeOf("number"));
  });

  it("reconciles persisted completion before expiring a provisional kill", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const killedAt = Date.parse("2026-03-24T11:55:00Z");
    const endedAt = Date.parse("2026-03-24T11:56:00Z");
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: endedAt,
        status: "done",
        startedAt,
        endedAt,
      }),
    );
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-killed-with-persisted-completion",
        task: "recover persisted completion",
        createdAt: startedAt,
        startedAt,
      }),
    );

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun("run-killed-with-persisted-completion");
      expect(run?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
      expect(run?.execution.outcome).toMatchObject({ status: "ok", startedAt, endedAt });
      expect(run?.archiveAtMs).toBeUndefined();
    });
  });

  it.each([
    {
      name: "repairs a provisional registry kill from a task-first completion",
      taskStatus: "succeeded" as const,
      expectedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      expectedOutcome: { status: "ok" },
    },
    {
      name: "preserves an error reason when replaying a task-first failure",
      taskStatus: "failed" as const,
      taskError: "provider failed",
      expectedReason: SUBAGENT_ENDED_REASON_ERROR,
      expectedOutcome: { status: "error", error: "provider failed" },
    },
  ])("$name", async ({ taskStatus, taskError, expectedReason, expectedOutcome }) => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const startedAt = Date.parse("2026-03-24T11:50:00Z");
      const killedAt = Date.parse("2026-03-24T11:55:00Z");
      const completedAt = Date.parse("2026-03-24T11:56:00Z");
      const runId = `run-task-first-${taskStatus}`;
      const childSessionKey = `agent:main:subagent:task-first-${taskStatus}`;
      expect(
        createRunningTaskRun(
          makeRunningTaskParams({
            childSessionKey,
            runId,
            task: "repair task-first completion",
            startedAt,
          }),
        ),
      ).not.toBeNull();
      expect(
        finalizeTaskRunByRunId({
          runId,
          runtime: "subagent",
          sessionKey: childSessionKey,
          status: taskStatus,
          endedAt: completedAt,
          lastEventAt: completedAt,
          error: taskError,
          progressSummary: "durable final result",
        }),
      ).toHaveLength(1);
      mocks.loadSessionStore.mockReturnValue({});
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "repair task-first completion",
          createdAt: startedAt,
          startedAt,
        }),
      );

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          endedReason: expectedReason,
          execution: {
            status: "terminal",
            endedAt: completedAt,
            outcome: { ...expectedOutcome, startedAt, endedAt: completedAt },
          },
          completion: { resultText: "durable final result", capturedAt: completedAt },
        });
        expect(run?.killReconciliation).toBeUndefined();
      });
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("replays task-first completion against the current steer generation deadline", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const originalStartedAt = 1_000;
      const replacementStartedAt = 100_000;
      const killedAt = 104_000;
      const completedAt = 105_000;
      const taskRunId = "run-task-first-original";
      const runId = "run-task-first-replacement";
      const childSessionKey = "agent:main:subagent:task-first-steer";
      expect(
        createRunningTaskRun(
          makeRunningTaskParams({
            sourceId: taskRunId,
            childSessionKey,
            runId: taskRunId,
            task: "finish after steer",
            startedAt: originalStartedAt,
          }),
        ),
      ).not.toBeNull();
      expect(
        finalizeTaskRunByRunId({
          runId: taskRunId,
          runtime: "subagent",
          sessionKey: childSessionKey,
          status: "succeeded",
          endedAt: completedAt,
          lastEventAt: completedAt,
          progressSummary: "replacement completed",
        }),
      ).toHaveLength(1);
      mocks.loadSessionStore.mockReturnValue({});
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          taskRunId,
          childSessionKey,
          task: "finish after steer",
          generation: 2,
          createdAt: replacementStartedAt,
          startedAt: replacementStartedAt,
          sessionStartedAt: originalStartedAt,
          runTimeoutSeconds: 10,
        }),
      );

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          execution: {
            status: "terminal",
            endedAt: completedAt,
            outcome: { status: "ok", startedAt: replacementStartedAt, endedAt: completedAt },
          },
        });
      });
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("retains persisted completion evidence when task projection fails", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const startedAt = Date.parse("2026-03-24T11:50:00Z");
      const completedAt = Date.parse("2026-03-24T11:54:00Z");
      const killedAt = Date.parse("2026-03-24T11:55:00Z");
      const runId = "run-killed-projection-retry";
      const childSessionKey = "agent:main:subagent:projection-retry";
      const task = createRunningTaskRun(
        makeRunningTaskParams({
          childSessionKey,
          runId,
          task: "retry completion projection",
          startedAt,
        }),
      );
      expect(task).not.toBeNull();
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: killedAt,
        lastEventAt: killedAt,
        error: "Cancelled by operator.",
      });
      const runtime = getDetachedTaskLifecycleRuntime();
      setDetachedTaskLifecycleRuntime({
        ...runtime,
        completeTaskRunByRunId: vi.fn(() => {
          throw new Error("task projection unavailable");
        }),
      });
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          sessionId: "sess-projection-retry",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      });
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "retry completion projection",
          createdAt: startedAt,
          startedAt,
        }),
      );

      await mod.testing.sweepOnceForTests();

      const run = findRequesterRun(runId);
      expect(run).toMatchObject({
        execution: { status: "terminal", endedAt: killedAt },
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        killReconciliation: { killedAt },
      });
      expect(findTaskByRunIdForStatus(runId)).toMatchObject({
        status: "cancelled",
        endedAt: killedAt,
      });
    } finally {
      resetDetachedTaskLifecycleRuntimeForTests();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("lets an opaque runtime recover persisted completion before expiring a kill", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const killedAt = Date.parse("2026-03-24T11:55:00Z");
    const endedAt = Date.parse("2026-03-24T11:56:00Z");
    const completeTaskRunByRunId = vi.fn(() => [{}] as never);
    const opaqueRuntime = {
      ...getDetachedTaskLifecycleRuntime(),
      completeTaskRunByRunId,
    };
    delete opaqueRuntime.findTaskRun;
    setDetachedTaskLifecycleRuntime(opaqueRuntime);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:opaque-child": {
        sessionId: "sess-opaque-child",
        updatedAt: endedAt,
        status: "done",
        startedAt,
        endedAt,
      },
    });
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-opaque-killed-with-persisted-completion",
        childSessionKey: "agent:main:subagent:opaque-child",
        task: "recover opaque persisted completion",
        createdAt: startedAt,
        startedAt,
      }),
    );

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun("run-opaque-killed-with-persisted-completion");
      expect(run).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          status: "terminal",
          endedAt,
          outcome: { status: "ok", startedAt, endedAt },
        },
      });
      expect(completeTaskRunByRunId).toHaveBeenCalledTimes(1);
    });
  });

  it("retires an opaque tombstone when persisted completion cannot update its task", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const killedAt = Date.parse("2026-03-24T11:55:00Z");
    const completedAt = Date.parse("2026-03-24T11:56:00Z");
    const childSessionKey = "agent:main:subagent:opaque-finalizer-miss";
    const completeTaskRunByRunId = vi.fn(() => [] as never);
    const finalizeTaskRunSpy = vi.fn(() => [] as never);
    const opaqueRuntime = {
      ...getDetachedTaskLifecycleRuntime(),
      completeTaskRunByRunId,
      finalizeTaskRunByRunId: finalizeTaskRunSpy,
    };
    delete opaqueRuntime.findTaskRun;
    setDetachedTaskLifecycleRuntime(opaqueRuntime);
    mocks.loadSessionStore.mockReturnValue({
      [childSessionKey]: {
        sessionId: "sess-opaque-finalizer-miss",
        updatedAt: completedAt,
        status: "done",
        startedAt,
        endedAt: completedAt,
      },
    });
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-opaque-finalizer-miss",
        childSessionKey,
        task: "bound opaque finalizer failure",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
      }),
    );

    await mod.testing.sweepOnceForTests();

    const run = findRequesterRun("run-opaque-finalizer-miss");
    expect(run?.killReconciliation).toBeUndefined();
    expect(completeTaskRunByRunId).toHaveBeenCalled();
    expect(finalizeTaskRunSpy).toHaveBeenCalled();
  });

  it("retires stable operator cancellation despite a late persisted completion", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const now = Date.parse("2026-03-24T12:00:00Z");
      const startedAt = now - 10_000;
      const killedAt = now - 1_000;
      const completedAt = now;
      const runId = "run-killed-stable-cancellation";
      const childSessionKey = "agent:main:subagent:stable-cancellation";
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          lifecycleRevision: "revision-stable-cancellation",
          sessionId: "sess-stable-cancellation",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      });
      expect(
        createRunningTaskRun(
          makeRunningTaskParams({
            childSessionKey,
            runId,
            task: "preserve operator cancellation",
            startedAt,
          }),
        ),
      ).not.toBeNull();
      expect(
        finalizeTaskRunByRunId({
          runId,
          runtime: "subagent",
          sessionKey: childSessionKey,
          status: "cancelled",
          endedAt: killedAt,
          lastEventAt: killedAt,
          error: "Cancelled by operator.",
        }),
      ).toHaveLength(1);
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve operator cancellation",
          cleanup: "delete",
          expectsCompletionMessage: true,
          createdAt: startedAt,
          startedAt,
          archiveAtMs: Date.now(),
        }),
      );

      expect(killedAt + 5 * 60_000).toBeGreaterThan(Date.now());
      vi.setSystemTime(killedAt + 5 * 60_000);

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .some((entry) => entry.runId === runId),
        ).toBe(false);
        expect(mocks.callGateway).toHaveBeenCalledWith({
          method: "sessions.delete",
          params: {
            key: childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
            expectedLifecycleRevision: "revision-stable-cancellation",
            expectedSessionId: "sess-stable-cancellation",
          },
          timeoutMs: 10_000,
        });
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("restores an explicit timeout that predates stable operator cancellation", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const now = Date.parse("2026-03-24T12:00:00Z");
      const startedAt = now - 10_000;
      const timeoutAt = now - 2_000;
      const killedAt = now - 1_000;
      const completedAt = now;
      const runId = "run-completed-before-stable-cancellation";
      const childSessionKey = "agent:main:subagent:completed-before-cancellation";
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          sessionId: "sess-completed-before-cancellation",
          updatedAt: completedAt,
          status: "killed",
          startedAt,
          endedAt: completedAt,
        },
      });
      createRunningTaskRun(
        makeRunningTaskParams({
          childSessionKey,
          runId,
          task: "preserve earlier completion",
          startedAt,
        }),
      );
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: killedAt,
        lastEventAt: killedAt,
        error: "Cancelled by operator.",
        suppressDelivery: true,
      });
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "preserve earlier completion",
          expectsCompletionMessage: false,
          createdAt: startedAt,
          startedAt,
          runTimeoutSeconds: 8,
        }),
      );

      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          execution: {
            status: "terminal",
            endedAt: timeoutAt,
            outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
          },
        });
        const task = findTaskByRunIdForStatus(runId);
        expect(task).toMatchObject({
          status: "timed_out",
          endedAt: timeoutAt,
        });
        expect(task?.error).toBeUndefined();
      });
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("suppresses registry delivery when cancellation becomes durable during capture", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const now = Date.now();
      const killedAt = now - 5 * 60_000;
      const startedAt = killedAt - 10_000;
      const completedAt = killedAt + 1_000;
      const runId = "run-cancelled-during-sweep-capture";
      const childSessionKey = "agent:main:subagent:cancelled-during-sweep-capture";
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          sessionId: "sess-cancelled-during-sweep-capture",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      });
      vi.setSystemTime(startedAt);
      createRunningTaskRun(
        makeRunningTaskParams({
          childSessionKey,
          runId,
          task: "cancel during result capture",
          startedAt,
        }),
      );
      vi.setSystemTime(now);
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: killedAt,
        lastEventAt: killedAt,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      let finishCapture: ((value: string) => void) | undefined;
      mocks.captureSubagentCompletionReply.mockImplementationOnce(
        async () =>
          await new Promise<string>((resolve) => {
            finishCapture = resolve;
          }),
      );
      mod.addSubagentRunForTests(
        makeKilledRun(killedAt, {
          runId,
          childSessionKey,
          task: "cancel during result capture",
          expectsCompletionMessage: false,
          createdAt: startedAt,
          startedAt,
        }),
      );

      const sweep = mod.testing.sweepOnceForTests();
      await vi.waitFor(() => expect(mocks.captureSubagentCompletionReply).toHaveBeenCalled());
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: killedAt,
        lastEventAt: Date.now(),
        error: "Cancelled by operator.",
      });
      expect(findTaskByRunIdForStatus(runId)).toMatchObject({
        status: "cancelled",
        error: "Cancelled by operator.",
        childSessionKey,
        createdAt: startedAt,
      });
      expect(
        findDetachedTaskRun({
          runId,
          runtime: "subagent",
          sessionKey: childSessionKey,
          createdAtOrAfter: startedAt,
        }),
      ).toMatchObject({
        lookup: "available",
        task: { status: "cancelled", error: "Cancelled by operator." },
      });
      finishCapture?.("late provider result");
      await sweep;
      await Promise.resolve();
      const remainingRun = findRequesterRun(runId);
      expect(remainingRun).toBeUndefined();

      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("uses the kill time when reconciling a yielded run", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const startedAt = Date.parse("2026-03-24T11:50:00Z");
      const yieldedAt = Date.parse("2026-03-24T11:59:00Z");
      const completedAt = Date.parse("2026-03-24T11:59:30Z");
      const killedAt = Date.parse("2026-03-24T12:00:00Z");
      const runId = "run-yielded-before-kill";
      const childSessionKey = "agent:main:subagent:yielded-before-kill";
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          sessionId: "sess-yielded-before-kill",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      });
      createRunningTaskRun(
        makeRunningTaskParams({
          childSessionKey,
          runId,
          task: "complete between yield and kill",
          startedAt,
        }),
      );
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        task: "complete between yield and kill",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
        endedAt: yieldedAt,
        pauseReason: "sessions_yield",
        cleanupHandled: false,
      });

      vi.setSystemTime(killedAt);
      expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
      expect(findTaskByRunIdForStatus(runId)).toMatchObject({
        status: "cancelled",
        endedAt: killedAt,
      });
      const killedRun = findRequesterRun(runId);
      expect(killedRun).toMatchObject({
        execution: { status: "terminal", endedAt: yieldedAt },
        cleanupCompletedAt: killedAt,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
      });

      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          execution: {
            status: "terminal",
            endedAt: completedAt,
            outcome: { status: "ok", startedAt, endedAt: completedAt },
          },
        });
        expect(findTaskByRunIdForStatus(runId)).toMatchObject({
          status: "succeeded",
          endedAt: completedAt,
        });
      });
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("expires a tombstone instead of replaying persisted killed state", async () => {
    const startedAt = Date.parse("2026-03-24T11:50:00Z");
    const endedAt = Date.parse("2026-03-24T11:55:00Z");
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: endedAt,
        status: "killed",
        startedAt,
        endedAt,
      }),
    );
    mod.addSubagentRunForTests(
      makeKilledRun(endedAt, {
        runId: "run-killed-with-persisted-kill",
        task: "expire persisted kill",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
      }),
    );

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-killed-with-persisted-kill"),
      ).toBe(false);
    });
  });

  it("keeps requester stop delivery suppressed after kill reconciliation", async () => {
    const killedAt = Date.now() - 5 * 60_000;
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-requester-stop-suppressed",
        childSessionKey: "agent:main:subagent:requester-stop-suppressed",
        task: "do not re-inject after stop",
        expectsCompletionMessage: true,
        createdAt: killedAt - 60_000,
        killReconciliation: { killedAt, suppressTaskDelivery: true },
      }),
    );

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-requester-stop-suppressed"),
      ).toBe(false);
    });

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("retires a superseded tombstone after its newer generation is released", async () => {
    const killedAt = Date.now() - 5 * 60_000;
    const childSessionKey = "agent:main:subagent:released-successor";
    mockPendingAgentWait();
    mod.addSubagentRunForTests(
      makeKilledRun(killedAt, {
        runId: "run-released-successor-old",
        childSessionKey,
        task: "retire only old ownership",
        cleanup: "delete",
        createdAt: killedAt - 60_000,
      }),
    );
    mod.registerSubagentRun({
      runId: "run-released-successor-new",
      childSessionKey,
      task: "new generation",
    });
    const oldRun = findRequesterRun("run-released-successor-old");
    expect(oldRun?.killReconciliation?.supersededAt).toBe(Date.now());
    mod.releaseSubagentRun("run-released-successor-new");

    await mod.testing.sweepOnceForTests();

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .some((entry) => entry.runId === "run-released-successor-old"),
    ).toBe(false);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
  });

  it("does not reconcile an old tombstone from a newer run completion", async () => {
    const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
    const oldEndedAt = Date.parse("2026-03-24T11:55:00Z");
    const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const newEndedAt = Date.parse("2026-03-24T11:59:00Z");
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:reused": {
        sessionId: "sess-reused",
        updatedAt: newEndedAt,
        status: "done",
        startedAt: newStartedAt,
        endedAt: newEndedAt,
      },
    });
    mocks.getAgentRunContext.mockImplementation((runId: string) =>
      runId === "run-new-generation" ? ({} as never) : undefined,
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-old-tombstone-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");
    const oldTranscriptTarget = {
      agentId: "main",
      sessionId: "internal-run-old-tombstone",
      sessionKey: "agent:main:internal-session-effects:run-old-tombstone",
      storePath: "/tmp/test-store",
    };
    mod.addSubagentRunForTests(
      makeKilledRun(oldEndedAt, {
        runId: "run-old-tombstone",
        childSessionKey: "agent:main:subagent:reused",
        task: "old generation",
        cleanup: "delete",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        sessionStartedAt: oldStartedAt,
        archiveAtMs: Date.now(),
        retainAttachmentsOnKeep: true,
        attachmentsDir,
        attachmentsRootDir,
        execution: {
          status: "terminal",
          startedAt: oldStartedAt,
          endedAt: oldEndedAt,
          transcriptTarget: oldTranscriptTarget,
        },
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-new-generation",
      childSessionKey: "agent:main:subagent:reused",
      task: "new generation",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation");
    expect(newRun).toBeDefined();
    expect(newRun?.execution.endedAt).toBeUndefined();
    expect(newRun?.execution.outcome).toBeUndefined();
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(
      mocks.onSubagentEnded.mock.calls.some(
        ([params]) => params.childSessionKey === "agent:main:subagent:reused",
      ),
    ).toBe(false);
    expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledWith(oldTranscriptTarget);
    await expectPathMissing(attachmentsDir);
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
  });

  it("checks the raw completion time before clamping an old run deadline", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
      const oldKilledAt = Date.parse("2026-03-24T11:55:00Z");
      const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
      const newEndedAt = Date.parse("2026-03-24T11:59:00Z");
      const childSessionKey = "agent:main:subagent:reused-no-start";
      mocks.loadSessionStore.mockReturnValue({
        [childSessionKey]: {
          sessionId: "sess-reused-no-start",
          updatedAt: newEndedAt,
          status: "done",
          endedAt: newEndedAt,
        },
      });
      createRunningTaskRun(
        makeRunningTaskParams({
          sourceId: "run-old-no-start",
          childSessionKey,
          runId: "run-old-no-start",
          task: "keep old cancellation canonical",
          startedAt: oldStartedAt,
        }),
      );
      finalizeTaskRunByRunId({
        runId: "run-old-no-start",
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: oldKilledAt,
        lastEventAt: oldKilledAt,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      mod.addSubagentRunForTests(
        makeKilledRun(oldKilledAt, {
          runId: "run-old-no-start",
          childSessionKey,
          task: "keep old cancellation canonical",
          createdAt: oldStartedAt,
          startedAt: oldStartedAt,
          runTimeoutSeconds: 60,
        }),
      );
      mod.addSubagentRunForTests({
        runId: "run-new-no-start",
        childSessionKey,
        task: "new generation without persisted start time",
        createdAt: newStartedAt,
        startedAt: newStartedAt,
        generation: 2,
      });

      await mod.testing.sweepOnceForTests();

      expect(findTaskByRunIdForStatus("run-old-no-start")).toMatchObject({
        status: "cancelled",
      });
      expect(findTaskByRunIdForStatus("run-old-no-start")?.status).not.toBe("timed_out");
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-old-no-start"),
      ).toBe(false);
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  it("does not restore a superseded lifecycle after a successor is released", async () => {
    const childSessionKey = "agent:main:subagent:released-timing-owner";
    mockPendingAgentWait();
    mocks.loadSessionStore.mockReturnValue({
      [childSessionKey]: { sessionId: "sess-released-timing-owner", updatedAt: 1 },
    });
    let releaseTimingWrite: (() => void) | undefined;
    let timingWriteStarted: (() => void) | undefined;
    const timingWriteStartedPromise = new Promise<void>((resolve) => {
      timingWriteStarted = resolve;
    });
    const timingWriteFinished = new Promise<void>((resolveFinished) => {
      mocks.patchSessionEntryCore.mockImplementationOnce(async (scope, update) => {
        timingWriteStarted?.();
        await new Promise<void>((resolve) => {
          releaseTimingWrite = resolve;
        });
        const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
          string,
          SessionEntry
        >;
        const current = expectDefined(
          store[scope.sessionKey],
          "store[scope.sessionKey] test invariant",
        );
        const patch = await update(current, { existingEntry: { ...current } });
        if (patch) {
          mocks.updateSessionStore(scope.storePath, () => {});
        }
        resolveFinished();
        return patch ? { ...current, ...patch } : current;
      });
    });

    mod.registerSubagentRun({
      runId: "run-released-timing-old",
      childSessionKey,
      task: "old timing owner",
    });
    expect(
      mod.markSubagentRunTerminated({
        runId: "run-released-timing-old",
        reason: "manual kill",
      }),
    ).toBe(1);
    await timingWriteStartedPromise;

    mod.registerSubagentRun({
      runId: "run-released-timing-new",
      childSessionKey,
      task: "new timing owner",
    });
    mod.releaseSubagentRun("run-released-timing-new");
    releaseTimingWrite?.();
    await timingWriteFinished;

    const oldRun = findRequesterRun("run-released-timing-old");
    expect(oldRun?.killReconciliation?.supersededAt).toBeTypeOf("number");
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("reconciles an old completion without touching the newer session generation", async () => {
    const oldStartedAt = Date.parse("2026-03-24T11:50:00Z");
    const oldKilledAt = Date.parse("2026-03-24T11:55:00Z");
    const oldCompletedAt = Date.parse("2026-03-24T11:56:00Z");
    const newStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const childSessionKey = "agent:main:subagent:reused-completed";
    mocks.loadSessionStore.mockReturnValue({
      [childSessionKey]: {
        sessionId: "sess-reused-completed",
        updatedAt: oldCompletedAt,
        status: "done",
        startedAt: oldStartedAt,
        endedAt: oldCompletedAt,
      },
    });
    mocks.getAgentRunContext.mockImplementation((runId: string) =>
      runId === "run-new-generation-after-completion" ? ({} as never) : undefined,
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mod.addSubagentRunForTests(
      makeKilledRun(oldKilledAt, {
        runId: "run-old-completed-tombstone",
        childSessionKey,
        task: "old completed generation",
        cleanup: "delete",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        sessionStartedAt: oldStartedAt,
      }),
    );
    mod.addSubagentRunForTests({
      runId: "run-new-generation-after-completion",
      childSessionKey,
      task: "new generation",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-completed-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation-after-completion");
    expect(newRun).toBeDefined();
    expect(newRun?.execution.endedAt).toBeUndefined();
    expect(newRun?.execution.outcome).toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
    expect(
      mocks.patchSessionEntryCore.mock.calls.some(
        ([scope]) => (scope as SessionAccessScope).sessionKey === childSessionKey,
      ),
    ).toBe(false);
    expect(
      mocks.emitSessionLifecycleEvent.mock.calls.some(
        ([event]) => (event as { sessionKey?: string }).sessionKey === childSessionKey,
      ),
    ).toBe(false);
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(
      mocks.onSubagentEnded.mock.calls.some(
        ([params]) => params.childSessionKey === childSessionKey,
      ),
    ).toBe(false);
  });

  it("uses session-store start time when sweeping stale explicit-timeout runs", async () => {
    mockPendingAgentWait();
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    const sessionEndedAt = createdAt + 65_000;
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: sessionEndedAt,
        status: "done",
        startedAt: sessionStartedAt,
        endedAt: sessionEndedAt,
      }),
    );

    vi.setSystemTime(createdAt);
    mod.registerSubagentRun({
      runId: "run-sweep-session-start",
      task: "sweep should respect session store start",
      runTimeoutSeconds: 60,
    });

    vi.setSystemTime(createdAt + 120_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = findRequesterRun("run-sweep-session-start");
      expect(run?.execution.endedAt).toBe(sessionEndedAt);
      expectRecordFields(
        run?.execution.outcome,
        {
          status: "ok",
          startedAt: sessionStartedAt,
          endedAt: sessionEndedAt,
          elapsedMs: 55_000,
        },
        "swept session store observed start outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("keeps restart-aborted runs active while recovery dependencies are unavailable", async () => {
    mockPendingAgentWait();
    mocks.loadSessionStore.mockReturnValue(
      createSessionStore({
        updatedAt: 333,
        status: "running",
        abortedLastRun: true,
      }),
    );

    mod.registerSubagentRun({
      runId: "run-stale-aborted",
      task: "resume after restart",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.testing.sweepOnceForTests();

    expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = findRequesterRun("run-stale-aborted");
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.execution.outcome).toBeUndefined();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-1",
      requesterOrigin: { channel: " quietchat ", accountId: " acct-1 " },
      task: "finish the task",
      cleanup: "delete",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      reason: "subagent-status",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "completion announce"),
      {
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-1",
        requesterSessionKey: "agent:main:main",
        requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
        task: "finish the task",
        cleanup: "delete",
        roundOneReply: "final completion reply",
        outcome: {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          elapsedMs: 111,
        },
      },
      "completion announce params",
    );

    expect(mocks.updateSessionStore).toHaveBeenCalledTimes(1);
    expect(getMockCallArg(mocks.updateSessionStore, 0, 0, "session store update")).toBe(
      "/tmp/test-session-store.json",
    );
    expect(getMockCallArg(mocks.updateSessionStore, 0, 1, "session store update")).toBeTypeOf(
      "function",
    );

    const updateStore = mocks.updateSessionStore.mock.calls.at(0)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    expect(updateStore).toBeTypeOf("function");
    const store = {
      "agent:main:subagent:child": {
        sessionId: "sess-child",
      },
    };
    updateStore?.(store);
    expectRecordFields(
      store["agent:main:subagent:child"],
      {
        startedAt: Date.parse("2026-03-24T12:00:00Z"),
        endedAt: 222,
        runtimeMs: 111,
        status: "done",
      },
      "updated child session store entry",
    );

    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalled();
  });

  it("retries completion after a transient durable registry write failure", async () => {
    mocks.persistSubagentRunsToDiskOrThrow
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("transient disk error");
      })
      .mockImplementation(() => {});

    mod.registerSubagentRun({
      runId: "run-retry-durable-completion",
      childSessionKey: "agent:main:subagent:retry-durable-completion",
      task: "retry durable completion",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-retry-durable-completion");
      expect(run).toMatchObject({
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        execution: {
          status: "terminal",
          endedAt: 222,
          outcome: { status: "ok", startedAt: 111, endedAt: 222 },
        },
      });
      expect(mocks.persistSubagentRunsToDiskOrThrow.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("throws and removes the entry when the initial durable registry write fails", () => {
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-durability-required",
        task: "must fail closed",
      }),
    ).toThrowError("disk full");

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-durability-required"),
    ).toBeUndefined();
  });

  it.each([
    { name: "running", queued: false },
    { name: "queued", queued: true },
  ])("persists a $name registration exactly once", ({ queued }) => {
    mockPendingAgentWait();

    const runId = `run-single-persist-${queued ? "queued" : "running"}`;
    mod.registerSubagentRun({
      runId,
      task: "persist one registry snapshot",
      queued,
    });

    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledWith(expect.any(Map), [runId]);
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
  });

  it.each([
    { name: "running", queued: false },
    { name: "queued", queued: true },
  ])("isolates a $name registration from task runtime input mutation", ({ queued }) => {
    const runId = `run-isolated-origin-${queued ? "queued" : "running"}`;
    const expectedRequesterOrigin = {
      channel: "discord",
      to: "channel:123",
      accountId: "acct-1",
      threadId: 42,
    };
    const requesterOrigin = {
      ...expectedRequesterOrigin,
      deliveryIntent: {
        id: "delivery-1",
        kind: "outbound_queue" as const,
        queuePolicy: "required" as const,
      },
    };
    let persistedEntry: SubagentRunRecord | undefined;
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce((runs) => {
      persistedEntry = structuredClone(runs.get(runId));
    });
    mockPendingAgentWait();
    const defaultRuntime = getDetachedTaskLifecycleRuntime();
    const mutateRequesterOrigin = (
      taskParams: Parameters<typeof defaultRuntime.createQueuedTaskRun>[0],
    ) => {
      if (!taskParams.requesterOrigin) {
        throw new Error("expected requester origin");
      }
      Object.assign(taskParams.requesterOrigin, {
        channel: "mutated",
        to: "mutated",
        accountId: "mutated",
        threadId: "mutated",
      });
    };
    const createMutatingQueuedTaskRun = vi.fn(
      (taskParams: Parameters<typeof defaultRuntime.createQueuedTaskRun>[0]) => {
        mutateRequesterOrigin(taskParams);
        return defaultRuntime.createQueuedTaskRun(taskParams);
      },
    );
    const createMutatingRunningTaskRun = vi.fn(
      (taskParams: Parameters<typeof defaultRuntime.createRunningTaskRun>[0]) => {
        mutateRequesterOrigin(taskParams);
        return defaultRuntime.createRunningTaskRun(taskParams);
      },
    );
    setDetachedTaskLifecycleRuntime({
      ...defaultRuntime,
      createQueuedTaskRun: createMutatingQueuedTaskRun,
      createRunningTaskRun: createMutatingRunningTaskRun,
    });

    mod.registerSubagentRun({
      runId,
      task: "isolate the registry delivery context",
      queued,
      requesterOrigin,
    });

    expect(
      queued ? createMutatingQueuedTaskRun : createMutatingRunningTaskRun,
    ).toHaveBeenCalledOnce();
    expect(findRequesterRun(runId)?.requesterOrigin).toEqual(expectedRequesterOrigin);
    expect(persistedEntry?.requesterOrigin).toEqual(expectedRequesterOrigin);
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
    expect(mocks.persistSubagentRunsToDisk).not.toHaveBeenCalled();
  });

  const optionalTaskRowFaults: Array<[label: string, createTaskRun: () => null]> = [
    ["returns no row", () => null],
    [
      "throws",
      () => {
        throw new Error("task store unavailable");
      },
    ],
  ];
  it.each(optionalTaskRowFaults)(
    "keeps ACP-style registry ownership when the secondary task runtime %s",
    (_label, createTaskRun) => {
      const runId = `run-acp-task-fault-${_label.replaceAll(" ", "-")}`;
      setDetachedTaskLifecycleRuntime({
        ...getDetachedTaskLifecycleRuntime(),
        createQueuedTaskRun: createTaskRun,
        createRunningTaskRun: createTaskRun,
      });
      mockPendingAgentWait();

      expect(() =>
        mod.registerSubagentRun({
          runId,
          task: "preserve ACP registry ownership",
        }),
      ).not.toThrow();

      expect(findRequesterRun(runId)).toMatchObject({
        runId,
        task: "preserve ACP registry ownership",
      });
    },
  );

  it("keeps memory aligned with the durable registration when rollback persistence fails", () => {
    const childSessionKey = "agent:main:subagent:task-row-rollback-failure";
    mod.addSubagentRunForTests({
      runId: "run-task-row-rollback-old",
      childSessionKey,
      task: "preserve the durable predecessor state",
      createdAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: Date.now() - 500 },
    });
    mocks.persistSubagentRunsToDiskOrThrow
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("rollback disk full");
      });
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      createRunningTaskRun: () => null,
    });
    mockPendingAgentWait();

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-task-row-rollback-new",
        childSessionKey,
        task: "retain the last durable snapshot",
        taskRowOwnership: "required",
      }),
    ).toThrowError("rollback disk full");

    expect(findRequesterRun("run-task-row-rollback-new")).toMatchObject({
      runId: "run-task-row-rollback-new",
      childSessionKey,
    });
    expect(
      findRequesterRun("run-task-row-rollback-old")?.killReconciliation?.supersededAt,
    ).toBeTypeOf("number");
    expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledTimes(2);
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent.wait",
        params: expect.objectContaining({ runId: "run-task-row-rollback-new" }),
      }),
    );
  });

  it("retains an already-running replacement when its durable write fails", () => {
    mockPendingAgentWait();
    mod.registerSubagentRun({
      runId: "run-replacement-persist-old",
      childSessionKey: "agent:main:subagent:replacement-persist",
      task: "keep live successor tracked",
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-replacement-persist-old",
        nextRunId: "run-replacement-persist-new",
      }),
    ).toBe(true);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-replacement-persist-old")).toBe(false);
    expect(runs).toEqual([
      expect.objectContaining({
        runId: "run-replacement-persist-new",
        taskRunId: "run-replacement-persist-old",
      }),
    ]);
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("rolls back an older kill ownership boundary when registration persistence fails", () => {
    const childSessionKey = "agent:main:subagent:registration-rollback";
    mod.addSubagentRunForTests({
      runId: "run-registration-rollback-old",
      childSessionKey,
      task: "preserve old ownership",
      createdAt: Date.now() - 1_000,
      endedAt: Date.now() - 500,
      endedReason: "subagent-killed",
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: Date.now() - 500 },
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() =>
      mod.registerSubagentRun({
        runId: "run-registration-rollback-new",
        childSessionKey,
        task: "new generation",
      }),
    ).toThrowError("disk full");

    const oldRun = findRequesterRun("run-registration-rollback-old");
    expect(oldRun?.killReconciliation).toEqual({ killedAt: Date.now() - 500 });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .some((entry) => entry.runId === "run-registration-rollback-new"),
    ).toBe(false);
  });

  it("rolls back a killed tombstone when its durable registry write fails", () => {
    mockPendingAgentWait();
    const runId = "run-kill-persist-failure";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:kill-persist-failure",
      task: "keep kill state atomic",
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toThrowError(
      "disk full",
    );

    const run = findRequesterRun(runId);
    expect(run?.execution.endedAt).toBeUndefined();
    expect(run?.endedReason).toBeUndefined();
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "running" });
  });

  it("continues completion announce cleanup when lifecycle cleanup fails", async () => {
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockRejectedValueOnce(
      new Error("browser cleanup unavailable"),
    );

    mod.registerSubagentRun({
      runId: "run-cleanup-warning",
      task: "finish despite cleanup warning",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });

    expect(mocks.cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "completion announce"),
      {
        childSessionKey: "agent:main:subagent:child",
        childRunId: "run-cleanup-warning",
        task: "finish despite cleanup warning",
      },
      "completion announce params",
    );

    const run = findRequesterRun("run-cleanup-warning");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");
  });

  it.each([
    {
      livenessState: "blocked",
      runId: "run-blocked-end",
      task: "overflow task",
      error: "Context overflow: prompt too large for the model.",
    },
    {
      livenessState: "abandoned",
      runId: "run-abandoned-end",
      task: "incomplete tool chain",
      error: "Agent run ended before producing a complete result.",
    },
  ] as const)(
    "announces $livenessState lifecycle end events as errors instead of success",
    async ({ livenessState, runId, task, error }) => {
      mockPendingAgentWait();

      mod.registerSubagentRun({
        runId,
        task,
        expectsCompletionMessage: true,
      });

      const lifecycleHandler = getLifecycleHandler();

      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: {
          phase: "start",
          startedAt: 10,
        },
      });
      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 10,
          endedAt: 20,
          livenessState,
          ...(livenessState === "blocked" ? { error } : { replayInvalid: true }),
        },
      });

      await waitForFast(() => {
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      });
      const announceParams = expectRecordFields(
        getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, `${livenessState} announce`),
        { childRunId: runId },
        `${livenessState} announce params`,
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "error",
          error,
          startedAt: 10,
          endedAt: 20,
          elapsedMs: 10,
        },
        `${livenessState} announce outcome`,
      );

      const run = findRequesterRun(runId);
      expect(run?.endedReason).toBe("subagent-error");
      expect(run?.execution.outcome?.status).toBe("error");
    },
  );

  it.each([
    {
      name: "publishes aborted lifecycle end events only after killed reconciliation",
      runId: "run-aborted-end",
      task: "aborted task",
      phase: "end" as const,
      event: { aborted: true, livenessState: "blocked", stopReason: "aborted" },
      verifiesAnnouncement: true,
    },
    {
      name: "publishes restart lifecycle end events only after killed reconciliation",
      runId: "run-restart-end",
      task: "restart task",
      phase: "end" as const,
      event: { aborted: true, stopReason: "restart" },
      verifiesAnnouncement: false,
    },
    {
      name: "publishes restart lifecycle error events only after killed reconciliation",
      runId: "run-restart-error",
      task: "restart error task",
      phase: "error" as const,
      event: {
        error: "ACP turn failed before completion",
        aborted: true,
        stopReason: "restart",
      },
      verifiesAnnouncement: false,
    },
  ])("$name", async ({ runId, task, phase, event, verifiesAnnouncement }) => {
    mockPendingAgentWait();
    mod.registerSubagentRun({ runId, task, expectsCompletionMessage: true });

    const lifecycleHandler = getLifecycleHandler();
    if (verifiesAnnouncement) {
      lifecycleHandler?.({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 10 },
      });
    }
    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase, startedAt: 10, endedAt: 20, ...event },
    });

    await waitForFast(() => {
      const run = findRequesterRun(runId);
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.execution.outcome?.status).toBe("error");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));

    if (verifiesAnnouncement) {
      const announceParams = expectRecordFields(
        getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted announce"),
        { childRunId: runId },
        "aborted announce params",
      );
      expectRecordFields(
        announceParams.outcome,
        {
          status: "error",
          error: "subagent run terminated",
          startedAt: 10,
          endedAt: 20,
          elapsedMs: 10,
        },
        "aborted announce outcome",
      );
      await waitForFast(() =>
        expect(
          mod
            .listSubagentRunsForRequester("agent:main:main")
            .some((entry) => entry.runId === runId),
        ).toBe(false),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    }
  });

  it("finishes canonical killed cleanup when its best-effort hook fails", async () => {
    mockPendingAgentWait();
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: vi.fn().mockRejectedValueOnce(new Error("ended hook unavailable")),
    } as never);

    mod.registerSubagentRun({
      runId: "run-killed-recovery",
      task: "killed recovery test",
      expectsCompletionMessage: false,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-killed-recovery",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 100 },
    });

    lifecycleHandler?.({
      runId: "run-killed-recovery",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 100,
        endedAt: 200,
        stopReason: "aborted",
      },
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-killed-recovery");
      expect(run?.execution.outcome?.status).toBe("error");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-killed-recovery"),
      ).toBe(false);
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("preserves run-mode keep entries past SESSION_RUN_TTL_MS sweep", async () => {
    mod.registerSubagentRun({
      runId: "run-keep-survives-ttl",
      task: "keep me past the session ttl",
      spawnMode: "run",
    });

    await waitForFast(() => {
      const run = findRequesterRun("run-keep-survives-ttl");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });

    vi.setSystemTime(new Date(Date.parse("2026-03-24T12:00:00Z") + 10 * 60_000));
    await mod.testing.sweepOnceForTests();

    const run = findRequesterRun("run-keep-survives-ttl");
    expect(run?.runId).toBe("run-keep-survives-ttl");
  });

  it("retries completion hooks before resuming ended cleanup", async () => {
    const runSubagentEnded = vi
      .fn()
      .mockRejectedValueOnce(new Error("ended hook unavailable"))
      .mockResolvedValue(undefined);
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded,
    } as never);

    mod.registerSubagentRun({
      runId: "run-hook-retry",
      task: "finish after hook retry",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      expect(runSubagentEnded.mock.calls.length).toBeGreaterThanOrEqual(2);
      const run = findRequesterRun("run-hook-retry");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("suppresses stale timeout announces when the same child run later finishes successfully", async () => {
    mockPendingAgentWait();

    mod.registerSubagentRun({
      runId: "run-timeout-then-ok",
      task: "timeout retry",
      expectsCompletionMessage: true,
    });

    const lifecycleHandler = getLifecycleHandler();

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", endedAt: 1_000, aborted: true },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    lifecycleHandler?.({
      runId: "run-timeout-then-ok",
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: 1_250,
        terminalReply: { disposition: "visible", text: "Finished successfully." },
      },
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    const timeoutAnnounce = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "timeout retry announce"),
      { childRunId: "run-timeout-then-ok" },
      "timeout retry announce params",
    );
    expectRecordFields(
      timeoutAnnounce.outcome,
      {
        status: "ok",
        endedAt: 1_250,
      },
      "timeout retry announce outcome",
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("retains delete-mode successful completions through the delivery deadline", async () => {
    const persist = (runs: Map<string, SubagentRunRecord>, runIds?: readonly string[]) =>
      saveSubagentRegistryChangesToSqlite(runs, runIds ?? [...runs.keys()]);
    mocks.persistSubagentRunsToDisk.mockImplementation(persist);
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementation(persist);
    mocks.runSubagentAnnounceFlow.mockResolvedValue("retryable");
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
      terminalReply: { disposition: "visible", text: "final completion reply" },
    });

    mod.registerSubagentRun({
      runId: "run-delete-give-up",
      task: "completion cleanup retry",
      cleanup: "delete",
      expectsCompletionMessage: true,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expectRecordFields(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
      { runId: "run-delete-give-up", cleanup: "delete" },
      "delete give-up run",
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mocks.runSubagentAnnounceFlow.mock.calls.length).toBeGreaterThan(3);
    expect(findRequesterRun("run-delete-give-up")?.delivery?.status).not.toBe("suspended");

    const deadlineAt = findRequesterRun("run-delete-give-up")?.delivery?.deadlineAt;
    expect(deadlineAt).toBeTypeOf("number");
    vi.setSystemTime((deadlineAt ?? Date.now()) + 1);
    mod.resumeSubagentRun("run-delete-give-up");
    await vi.advanceTimersByTimeAsync(0);
    expect(findRequesterRun("run-delete-give-up")?.delivery).toMatchObject({
      status: "suspended",
      suspendedReason: "expiry",
    });
  });

  it("retries and retires completion delete runs regardless of prior attempt count", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set(
        "run-resume-delete",
        createSubagentRunRecord({
          runId: "run-resume-delete",
          task: "resume delete retry budget",
          cleanup: "delete",
          createdAt: Date.parse("2026-03-24T11:58:00Z"),
          startedAt: Date.parse("2026-03-24T11:59:00Z"),
          endedAt: Date.parse("2026-03-24T11:59:30Z"),
          expectsCompletionMessage: true,
          delivery: {
            status: "pending",
            attemptCount: 3,
            lastAttemptAt: Date.parse("2026-03-24T11:59:40Z"),
          },
        }),
      );
      return 1;
    }) as never);

    hydrateAndActivateRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(findRequesterRun("run-resume-delete")).toBeUndefined();
  });

  it("retries and settles keep-mode completions regardless of prior attempt count", async () => {
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set(
        "run-resume-keep",
        createSubagentRunRecord({
          runId: "run-resume-keep",
          task: "resume keep retry budget",
          createdAt: Date.parse("2026-03-24T11:58:00Z"),
          startedAt: Date.parse("2026-03-24T11:59:00Z"),
          endedAt: Date.parse("2026-03-24T11:59:30Z"),
          endedReason: "subagent-complete",
          expectsCompletionMessage: true,
          outcome: { status: "ok" },
          completion: { required: true, resultText: "child completed successfully" },
          delivery: {
            status: "pending",
            attemptCount: 3,
            lastAttemptAt: Date.parse("2026-03-24T11:59:40Z"),
            lastError: "gateway request timeout for agent",
            payload: {
              childRunId: "run-resume-keep",
              task: "resume keep retry budget",
              endedAt: Date.parse("2026-03-24T11:59:30Z"),
              outcome: { status: "ok" },
              expectsCompletionMessage: true,
            },
          },
        }),
      );
      return 1;
    }) as never);

    hydrateAndActivateRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    const run = findRequesterRun("run-resume-keep");
    expect(run?.delivery?.status).toBe("delivered");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    expect(run?.completion?.resultText).toBe("child completed successfully");
  });

  it("clears suspended final delivery fields when reactivating a subagent run", () => {
    const endedAt = Date.parse("2026-03-24T11:59:30Z");
    mod.addSubagentRunForTests({
      runId: "run-suspended-old",
      childSessionKey: "agent:main:subagent:reactivated",
      task: "reactivate suspended delivery",
      expectsCompletionMessage: true,
      createdAt: endedAt - 30_000,
      startedAt: endedAt - 20_000,
      endedAt,
      endedReason: "subagent-error",
      outcome: { status: "error", error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery",
      completion: { required: true, resultText: "child completed successfully" },
      delivery: {
        status: "suspended",
        createdAt: endedAt + 1_000,
        lastAttemptAt: endedAt + 2_000,
        attemptCount: 3,
        lastError: "gateway request timeout for agent",
        payload: {
          childSessionKey: "agent:main:subagent:reactivated",
          childRunId: "run-suspended-old",
          task: "reactivate suspended delivery",
          endedAt,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
        },
        suspendedAt: endedAt + 3_000,
        suspendedReason: "expiry",
      },
    });

    expect(
      mod.replaceSubagentRunAfterSteerCore({
        previousRunId: "run-suspended-old",
        nextRunId: "run-suspended-new",
      }),
    ).toBe(true);

    const replacement = findRequesterRun("run-suspended-new");
    expect(replacement).toMatchObject({
      runId: "run-suspended-new",
      cleanup: "keep",
      cleanupHandled: false,
    });
    expect(replacement?.execution.endedAt).toBeUndefined();
    expect(replacement?.terminalOwner).toBeUndefined();
    expect(replacement?.delivery?.lastError).toBeUndefined();
    expect(replacement?.delivery?.payload).toBeUndefined();
    expect(replacement?.delivery?.suspendedAt).toBeUndefined();
    expect(replacement?.delivery?.suspendedReason).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:parent": {
        lifecycleRevision: "revision-parent",
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        lifecycleRevision: "revision-child",
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });

    mod.addSubagentRunForTests({
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      task: "expired parent cleanup",
      cleanup: "delete",
      createdAt: Date.parse("2026-03-24T11:50:00Z"),
      startedAt: Date.parse("2026-03-24T11:50:30Z"),
      endedAt: Date.parse("2026-03-24T11:51:00Z"),
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    mod.registerSubagentRun({
      runId: "run-child-finished",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles",
    });

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === "run-parent-expired"),
      ).toBeUndefined();
    });

    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-child-finished" },
      "child finished announce params",
    );
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:parent",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
  });

  it("wakes a sessions_yield-paused parent when pending descendants settle", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: 1,
      },
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });

    mod.addSubagentRunForTests({
      runId: "run-yielded-parent",
      childSessionKey: "agent:main:subagent:parent",
      task: "yielded parent waiting on descendants",
      createdAt: Date.parse("2026-06-26T02:17:00Z"),
      startedAt: Date.parse("2026-06-26T02:18:00Z"),
      endedAt: Date.parse("2026-06-26T02:19:00Z"),
      pauseReason: "sessions_yield",
      wakeOnDescendantSettle: true,
      cleanupHandled: false,
      cleanupCompletedAt: undefined,
    });

    mod.registerSubagentRun({
      runId: "run-yielded-child-finished",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles after yield",
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
    });
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "child finished announce"),
      { childRunId: "run-yielded-child-finished" },
      "child finished announce params",
    );
    expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 1, 0, "yielded parent wake announce"),
      {
        childRunId: "run-yielded-parent",
        wakeOnDescendantSettle: true,
      },
      "yielded parent wake announce params",
    );
  });

  it("defers the killed hook until the provisional result reconciles", async () => {
    mockPendingAgentWait();
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);

    mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
      task: "kill after init",
      expectsCompletionMessage: false,
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-init",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    const killedRun = findRequesterRun("run-killed-init");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    expect(killedRun?.execution.outcome).toEqual({
      status: "error",
      error: "manual kill",
      startedAt: killedAt,
      endedAt: killedAt,
      elapsedMs: 0,
    });
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    vi.setSystemTime(killedAt + 5 * 60_000);
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentEnded).toHaveBeenCalled());
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 0, "subagent ended hook"),
      {
        targetSessionKey: "agent:main:subagent:killed",
        reason: "subagent-killed",
        accountId: "acct-1",
        runId: "run-killed-init",
        outcome: "killed",
        error: "manual kill",
      },
      "subagent ended hook params",
    );
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 1, "subagent ended hook context"),
      {
        runId: "run-killed-init",
        childSessionKey: "agent:main:subagent:killed",
        requesterSessionKey: "agent:main:main",
      },
      "subagent ended hook context",
    );
  });

  it("keeps killed delete-mode runs as reconciliation tombstones", async () => {
    mod.registerSubagentRun({
      runId: "run-killed-delete",
      childSessionKey: "agent:main:subagent:killed-delete",
      task: "kill and delete",
      cleanup: "delete",
      workspaceDir: "/tmp/killed-delete-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete"),
    ).toMatchObject({
      cleanup: "delete",
      cleanupHandled: true,
      endedReason: "subagent-killed",
      execution: { outcome: { status: "error", error: "manual kill" } },
    });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-delete")?.archiveAtMs,
    ).toBeUndefined();
    expect(findTaskByRunIdForStatus("run-killed-delete")).toMatchObject({
      status: "cancelled",
      error: SUBAGENT_KILL_TASK_ERROR,
      deliveryStatus: "pending",
    });
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
  });

  it("does not replace durable task completion when a provisional kill is replayed", () => {
    const runId = "run-repeated-kill-after-task-success";
    const childSessionKey = "agent:main:subagent:repeated-kill-after-task-success";
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      task: "finish before registry reconciliation persists",
    });

    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    expect(
      finalizeTaskRunByRunId({
        runId,
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "succeeded",
        endedAt: Date.now() + 1,
        lastEventAt: Date.now() + 1,
        progressSummary: "durable provider completion",
      }),
    ).toHaveLength(1);

    // Simulate task-first completion followed by a failed registry commit and
    // a repeated admin kill against the retained reconciliation tombstone.
    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({
      status: "succeeded",
      progressSummary: "durable provider completion",
    });
  });

  it("suppresses task delivery immediately when requester teardown kills a run", () => {
    mod.registerSubagentRun({
      runId: "run-requester-teardown",
      childSessionKey: "agent:main:subagent:requester-teardown",
      task: "stop without reinjecting",
    });

    expect(
      mod.markSubagentRunTerminated({
        runId: "run-requester-teardown",
        reason: "manual kill",
        suppressTaskDelivery: true,
      }),
    ).toBe(1);

    expect(findTaskByRunIdForStatus("run-requester-teardown")).toMatchObject({
      status: "cancelled",
      error: SUBAGENT_KILL_TASK_ERROR,
      deliveryStatus: "not_applicable",
    });
  });

  it("emits only the canonical completion hook when completion beats a provisional kill", async () => {
    mockPendingAgentWait();
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mod.registerSubagentRun({
      runId: "run-killed-hook-race",
      childSessionKey: "agent:main:subagent:killed-hook-race",
      task: "finish while kill hook is publishing",
      expectsCompletionMessage: false,
    });
    const lifecycleHandler = getLifecycleHandler();

    expect(
      mod.markSubagentRunTerminated({
        runId: "run-killed-hook-race",
        reason: "manual kill",
      }),
    ).toBe(1);
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();

    lifecycleHandler?.({
      runId: "run-killed-hook-race",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 200 },
    });
    await waitForFast(() => {
      const run = findRequesterRun("run-killed-hook-race");
      expect(run?.endedReason).toBe("subagent-complete");
    });
    expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 0, "exactly-once completion hook"),
      { reason: "subagent-complete", outcome: "ok", error: undefined },
      "exactly-once completion hook",
    );
  });

  it("removes attachments for killed delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-kill-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.registerSubagentRun({
      runId: "run-killed-delete-attachments",
      childSessionKey: "agent:main:subagent:killed-delete-attachments",
      task: "kill and delete attachments",
      cleanup: "delete",
      attachmentsDir,
      attachmentsRootDir,
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-delete-attachments",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    await waitForFast(async () => {
      await expectPathMissing(attachmentsDir);
    });
  });

  it("announces readable failure when an interrupted run is finalized", async () => {
    mod.addSubagentRunForTests({
      runId: "run-interrupted",
      childSessionKey: "agent:main:subagent:interrupted",
      controllerSessionKey: "agent:main:main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
      task: "recover interrupted subagent",
      expectsCompletionMessage: true,
      spawnMode: "run",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    const updated = await mod.finalizeInterruptedSubagentRun({
      runId: "run-interrupted",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      endedAt: 2,
    });

    expect(updated).toBe(1);
    await waitForFast(() => {
      const announceParams = findRecordCallArg(
        mocks.runSubagentAnnounceFlow,
        0,
        "interrupted announce",
        (record) => record.childRunId === "run-interrupted",
      );
      expectRecordFields(
        announceParams,
        {
          childRunId: "run-interrupted",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
        },
        "interrupted announce params",
      );
      const outcome = expectRecordFields(
        announceParams.outcome,
        { status: "error" },
        "interrupted announce outcome",
      );
      expect(String(outcome.error)).toContain("Automatic recovery failed after 2 attempts");
    });
    const run = findRequesterRun("run-interrupted");
    expect(run?.execution.outcome).toEqual({
      status: "error",
      error:
        "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
      startedAt: 1,
      endedAt: 2,
      elapsedMs: 1,
    });
    expect(run?.terminalOwner).toBe("interrupted-recovery");
    expect(run?.cleanupCompletedAt).toBeTypeOf("number");

    const announceCalls = mocks.runSubagentAnnounceFlow.mock.calls.length;
    await expect(
      mod.finalizeInterruptedSubagentRun({
        runId: "run-interrupted",
        error:
          "Subagent run was interrupted by a gateway restart or connection loss. Automatic recovery failed after 2 attempts. Please retry.",
        endedAt: 2,
      }),
    ).resolves.toBe(1);
    expect(run?.terminalOwner).toBe("interrupted-recovery");
    expect(run?.execution.outcome?.error).toContain("Automatic recovery failed after 2 attempts");
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(announceCalls);
  });

  it("returns zero without mutating the run or task when recovery persistence fails", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const runId = "run-interrupted-persist-failure";
      const childSessionKey = "agent:main:subagent:interrupted-persist-failure";
      createRunningTaskRun(
        makeRunningTaskParams({
          childSessionKey,
          runId,
          task: "preserve interrupted task",
          startedAt: 1,
        }),
      );
      const entry = createSubagentRunRecord({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve interrupted task",
        cleanup: "keep" as const,
        createdAt: 1,
        execution: { status: "running", startedAt: 1 },
      });
      mod.addSubagentRunForTests(entry);
      const original = structuredClone(entry);
      mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
        throw new Error("registry store boom");
      });

      await expect(
        mod.finalizeInterruptedSubagentRun({
          runId,
          error: "restart interrupted run",
          endedAt: 2,
        }),
      ).resolves.toBe(0);

      expect(mocks.persistSubagentRunsToDiskOrThrow).toHaveBeenCalledOnce();
      expect(
        mod.listSubagentRunsForRequester("agent:main:main").find((run) => run.runId === runId),
      ).toEqual(original);
      expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "running" });
    } finally {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });

  const completeTerminalOutcome = {
    status: "error" as const,
    error: "existing failure",
    startedAt: 1,
    endedAt: 2,
    elapsedMs: 1,
  };
  const completeTerminalEvidence = {
    endedReason: SUBAGENT_ENDED_REASON_ERROR,
    execution: {
      status: "terminal" as const,
      startedAt: 1,
      endedAt: 2,
      outcome: completeTerminalOutcome,
    },
  };
  it.each([
    [
      "missing-ended-at",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "terminal" as const, startedAt: 1, outcome: completeTerminalOutcome },
      },
      undefined,
    ],
    [
      "missing-outcome",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "terminal" as const, startedAt: 1, endedAt: 2 },
      },
      undefined,
    ],
    ["missing-ended-reason", 0, { ...completeTerminalEvidence, endedReason: undefined }, undefined],
    [
      "nonterminal-execution",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "running" as const, startedAt: 1 },
      },
      undefined,
    ],
    ["cleanup-complete", 1, completeTerminalEvidence, 2],
    [
      "cleanup-partial",
      0,
      {
        ...completeTerminalEvidence,
        execution: { status: "terminal" as const, startedAt: 1, endedAt: 2 },
      },
      2,
    ],
  ])(
    "%s terminal evidence returns %i",
    async (scenario, expected, evidence, cleanupCompletedAt) => {
      const runId = `run-interrupted-${scenario}`;
      const entry = createSubagentRunRecord({
        runId,
        childSessionKey: `agent:main:subagent:interrupted-${scenario}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve existing terminal evidence",
        cleanup: "keep" as const,
        createdAt: 1,
        cleanupCompletedAt,
        ...evidence,
      });
      mod.addSubagentRunForTests(entry);
      const original = structuredClone(entry);

      await expect(
        mod.finalizeInterruptedSubagentRun({
          runId,
          error: "restart interrupted run",
          endedAt: 3,
        }),
      ).resolves.toBe(expected);

      expect(
        mod.listSubagentRunsForRequester("agent:main:main").find((run) => run.runId === runId),
      ).toEqual(original);
    },
  );

  it("removes attachments for released delete-mode runs", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-release-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact");

    mod.addSubagentRunForTests({
      runId: "run-release-delete",
      childSessionKey: "agent:main:subagent:release-delete",
      controllerSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      task: "release attachments",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      attachmentsDir,
      attachmentsRootDir,
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-delete");

    await waitForFast(async () => {
      await expectPathMissing(attachmentsDir);
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:release-delete",
        reason: "released",
        workspaceDir: undefined,
      });
    });
  });

  it("loads context-engine runtime before released end hooks", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(pluginRegistry);
    mocks.resolveContextEngine.mockImplementationOnce(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
      return {
        onSubagentEnded: async (params: ContextEngineSubagentEndedParams) => {
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
          await mocks.onSubagentEnded(params);
        },
      };
    });
    mod.addSubagentRunForTests({
      runId: "run-release-context-engine",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      agentDir: "/tmp/agent-alt",
      workspaceDir: "/tmp/workspace",
      createdAt: 1,
      startedAt: 1,
      sessionStartedAt: 1,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
    });

    mod.releaseSubagentRun("run-release-context-engine");

    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        agentDir: "/tmp/agent-alt",
        childSessionKey: "agent:main:session:child",
        reason: "released",
        workspaceDir: "/tmp/workspace",
      });
    });
    expect(mocks.ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
    expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
      {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      {
        agentDir: "/tmp/agent-alt",
        workspaceDir: "/tmp/workspace",
      },
    );
  });

  it("passes stored agentDir through swept context-engine cleanup paths", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    mocks.loadSessionStore.mockReturnValue({
      "agent:alt:session:child-archive": {
        lifecycleRevision: "revision-child-archive",
        sessionId: "session-child-archive",
        updatedAt: now,
      },
    });
    mod.addSubagentRunForTests({
      runId: "run-session-swept-context-engine",
      childSessionKey: "agent:alt:session:child-session",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "session cleanup",
      expectsCompletionMessage: undefined,
      spawnMode: "session",
      agentDir: "/tmp/agent-session",
      workspaceDir: "/tmp/workspace-session",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 6 * 60_000,
    });
    mod.addSubagentRunForTests({
      runId: "run-archive-swept-context-engine",
      childSessionKey: "agent:alt:session:child-archive",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "archive cleanup",
      cleanup: "delete",
      expectsCompletionMessage: undefined,
      spawnMode: "run",
      agentDir: "/tmp/agent-archive",
      workspaceDir: "/tmp/workspace-archive",
      createdAt: now - 20_000,
      startedAt: now - 10_000,
      sessionStartedAt: now - 10_000,
      accumulatedRuntimeMs: 0,
      endedAt: now - 8_000,
      outcome: { status: "ok", startedAt: now - 10_000, endedAt: now - 8_000, elapsedMs: 2_000 },
      archiveAtMs: now - 1,
      cleanupHandled: true,
    });

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "session context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-session" &&
          record.workspaceDir === "/tmp/workspace-session",
      );
      findRecordCallArg(
        mocks.resolveContextEngine,
        1,
        "archive context engine cleanup",
        (record) =>
          record.agentDir === "/tmp/agent-archive" &&
          record.workspaceDir === "/tmp/workspace-archive",
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-session",
          workspaceDir: "/tmp/workspace-session",
        },
      );
      expect(mocks.resolveContextEngine).toHaveBeenCalledWith(
        {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        {
          agentDir: "/tmp/agent-archive",
          workspaceDir: "/tmp/workspace-archive",
        },
      );
    });
  });

  it("expires suspended cron final deliveries after seven days", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-cron-expired";
    mod.addSubagentRunForTests(
      makeSuspendedDeliveryRun({
        runId,
        childSessionKey: "agent:main:subagent:suspended-cron",
        controllerSessionKey: "agent:main:cron:cron-1:run:parent",
        requesterSessionKey: "agent:main:cron:cron-1:run:parent",
        requesterDisplayKey: "cron",
        task: "cron suspended delivery",
        spawnMode: "session",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        completion: { required: true, resultText: "large final payload" },
        delivery: {
          lastAttemptAt: now - 7 * 24 * 60 * 60_000 - 1,
          suspendedAt: now - 7 * 24 * 60 * 60_000 - 1,
        },
      }),
    );

    await mod.testing.sweepOnceForTests();

    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:suspended-cron");
    expect(run).toMatchObject({
      runId,
      delivery: {
        status: "discarded",
        payload: undefined,
        suspendedAt: undefined,
        suspendedReason: undefined,
        discardedAt: now,
        discardReason: "expired",
      },
      cleanupHandled: true,
      cleanupCompletedAt: now,
    });
    expect(run?.delivery?.discardedPayloadSummary).toEqual({
      requesterSessionKey: "agent:main:cron:cron-1:run:parent",
      childSessionKey: "agent:main:subagent:suspended-cron",
      childRunId: runId,
      endedAt: now - 8 * 24 * 60 * 60_000,
      status: "ok",
      lastError: "gateway request timeout for agent",
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:suspended-cron",
        reason: "completed",
        workspaceDir: undefined,
      });
    });
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("does not emit ended hooks before suspended delete retirement is durable", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-delete-persist-failure";
    const childSessionKey = "agent:main:subagent:suspended-delete-persist-failure";
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("registry deletion failed");
    });
    mod.addSubagentRunForTests(
      makeSuspendedDeliveryRun({
        runId,
        childSessionKey,
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "discard suspended delete delivery",
        cleanup: "delete",
        spawnMode: "run",
        createdAt: now - 8 * 24 * 60 * 60_000,
        endedAt: now - 8 * 24 * 60 * 60_000,
        delivery: {
          lastAttemptAt: now - 7 * 24 * 60 * 60_000 - 1,
          suspendedAt: now - 7 * 24 * 60 * 60_000 - 1,
        },
      }),
    );
    const original = structuredClone(mod.getSubagentRunByChildSessionKey(childSessionKey));

    await expect(mod.testing.sweepOnceForTests()).rejects.toThrow("registry deletion failed");

    expect(mod.getSubagentRunByChildSessionKey(childSessionKey)).toEqual(original);
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.onSubagentEnded).not.toHaveBeenCalled();
    expect(mocks.removeInternalSessionEffectsSession).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();

    expect(mod.getSubagentRunByChildSessionKey(childSessionKey)).toBeNull();
    expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    await waitForFast(() => {
      expect(mocks.removeInternalSessionEffectsSession).toHaveBeenCalledTimes(1);
    });
  });

  it("retains suspended final deliveries when backlog exceeds the hard cap", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    for (let i = 0; i < 51; i += 1) {
      const runId = `run-suspended-pressure-${i}`;
      mod.addSubagentRunForTests(
        makeSuspendedDeliveryRun({
          runId,
          childSessionKey: `agent:main:subagent:suspended-pressure-${i}`,
          controllerSessionKey: "agent:main:main",
          requesterSessionKey: "agent:main:telegram:direct:418181497",
          requesterDisplayKey: "telegram",
          task: "interactive suspended delivery",
          spawnMode: "session",
          createdAt: now - 60_000,
          endedAt: now - 60_000,
          delivery: {
            lastAttemptAt: now - 60_000 + i,
            suspendedAt: now - 60_000 + i,
          },
        }),
      );
    }

    await mod.testing.sweepOnceForTests();

    const runs = Array.from({ length: 51 }, (_, i) =>
      mod.getSubagentRunByChildSessionKey(`agent:main:subagent:suspended-pressure-${i}`),
    );
    const stillSuspended = runs.filter(
      (run) =>
        run?.delivery?.status === "suspended" && typeof run.delivery.suspendedAt === "number",
    );
    expect(stillSuspended).toHaveLength(51);
    expect(runs.every((run) => run?.delivery?.discardReason === undefined)).toBe(true);
    expect(mod.getSubagentDeliveryBacklogPressure()).toEqual({ suspended: 51, blocked: true });
  });

  it("contains per-row and background sweeper failures", async () => {
    mod.registerSubagentRun({
      runId: "run-sweep-error",
      task: "sweep error",
      cleanup: "delete",
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).toBeDefined();
    run!.execution.startedAt = Date.now() - 2_000;
    mocks.loadSessionStore.mockImplementation(() => {
      throw new Error("simulated sweep failure");
    });

    await expect(mod.testing.sweepOnceForTests()).resolves.toBeUndefined();
    await expect(mod.testing.runSweeperTickForTests()).resolves.toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
