// Subagent registry tests cover run state, completion capture, archive cleanup,
// persistence, lifecycle hooks, and orphan recovery scheduling.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type {
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import {
  createRunningTaskRun,
  findDetachedTaskRun,
  finalizeTaskRunByRunId,
  getDetachedTaskLifecycleRuntime,
} from "../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/task-runtime.test-helpers.js";
import { findTaskByRunIdForStatus } from "../tasks/task-status-access.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { testing as swarmSchedulerTesting } from "./swarm-scheduler.test-support.js";

const noop = () => {};
const waitForFast = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 1_000, interval: 1 });

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getMockCallArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
  label: string,
): unknown {
  const call = (mock.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call[argIndex];
}

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
  callGateway: vi.fn<(request: { method?: string }) => Promise<Record<string, unknown>>>(),
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
  listSessionEntries: vi.fn((scope: Omit<SessionAccessScope, "sessionKey">) => {
    const store = mocks.loadSessionStore(scope.storePath, { clone: false }) as Record<
      string,
      SessionEntry
    >;
    return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
  }),
  loadSessionStore: vi.fn((_storePath?: string, _options?: { clone?: boolean }) => ({})),
  patchSessionEntry: vi.fn(
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
  captureSubagentCompletionReply: vi.fn(async () => "final completion reply"),
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
  runSubagentAnnounceFlow: vi.fn(async () => true),
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
  ensureRuntimePluginsLoaded: vi.fn(),
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
  onSubagentEnded: vi.fn<
    (params: { childSessionKey?: string }, context?: unknown) => Promise<void>
  >(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
  removeInternalSessionEffectsSession: vi.fn(async () => {}),
  resolveAgentTimeoutMs: vi.fn(() => 1_000),
  getGatewayRecoveryRuntime: vi.fn(() => ({
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  })),
  scheduleOrphanRecovery: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext: mocks.getAgentRunContext,
  onAgentEvent: mocks.onAgentEvent,
}));

vi.mock("../config/config.js", () => {
  return {
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
  resolveStorePath: mocks.resolveStorePath,
  updateSessionStore: mocks.updateSessionStore,
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
  loadSessionEntry: mocks.loadSessionEntry,
  patchSessionEntry: mocks.patchSessionEntry,
}));

vi.mock("../sessions/session-lifecycle-events.js", () => ({
  emitSessionLifecycleEvent: mocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagent-registry-state.js", () => ({
  clearSubagentRunsReadCacheForTest: mocks.clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead: mocks.getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk: mocks.persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow: mocks.persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk: mocks.restoreSubagentRunsFromDisk,
}));

vi.mock("./subagent-announce.js", () => ({
  captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
  runSubagentAnnounceFlow: mocks.runSubagentAnnounceFlow,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.getGlobalHookRunner,
}));

vi.mock("./runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
}));

vi.mock("../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

vi.mock("./timeout.js", () => ({
  resolveAgentTimeoutMs: mocks.resolveAgentTimeoutMs,
}));

vi.mock("./subagent-orphan-recovery.js", () => ({
  scheduleOrphanRecovery: mocks.scheduleOrphanRecovery,
}));

vi.mock("./internal-session-effects.js", () => ({
  removeInternalSessionEffectsSession: mocks.removeInternalSessionEffectsSession,
}));

describe("subagent registry seam flow", () => {
  let mod: typeof import("./subagent-registry.test-helpers.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.test-helpers.js");
  });

  beforeEach(() => {
    resetGatewayWorkAdmission();
    resetDetachedTaskLifecycleRuntimeForTests();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
      },
    });
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockResolvedValue(undefined);
    mocks.resolveContextEngine.mockResolvedValue({
      onSubagentEnded: mocks.onSubagentEnded,
    });
    mocks.scheduleOrphanRecovery.mockReset();
    mocks.resolveAgentTimeoutMs.mockReturnValue(1_000);
    mocks.restoreSubagentRunsFromDisk.mockReturnValue(0);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
        };
      }
      return {};
    });
    mod.testing.setDepsForTest({
      callGateway: mocks.callGateway as typeof import("../gateway/call.js").callGateway,
      captureSubagentCompletionReply: mocks.captureSubagentCompletionReply,
      cleanupBrowserSessionsForLifecycleEnd: mocks.cleanupBrowserSessionsForLifecycleEnd,
      getGatewayRecoveryRuntime: mocks.getGatewayRecoveryRuntime,
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
      ensureRuntimePluginsLoaded: mocks.ensureRuntimePluginsLoaded,
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
    for (const [suffix, archiveAtMs] of [
      ["one", now - 1],
      ["two", now + 1_000],
    ] as const) {
      mod.addSubagentRunForTests({
        runId: `run-collector-${suffix}`,
        childSessionKey: `agent:main:subagent:collector-${suffix}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "retain lifetime group count",
        cleanup: "delete",
        createdAt: now - 10_000,
        endedAt: now - 5_000,
        cleanupCompletedAt: now - 4_000,
        archiveAtMs,
        collect: true,
        groupId: "swarm:lifetime",
        collectorCompletion: { status: "done" },
      });
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

  it("keeps collector groups while any member owes failed-launch cleanup", async () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-collector-clean",
      childSessionKey: "agent:main:subagent:collector-clean",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "completed sibling",
      cleanup: "keep",
      createdAt: now - 10_000,
      endedAt: now - 5_000,
      archiveAtMs: now - 1,
      collect: true,
      groupId: "swarm:cleanup-pending",
      collectorCompletion: { status: "done" },
    });
    mod.addSubagentRunForTests({
      runId: "run-collector-cleanup-pending",
      childSessionKey: "agent:main:subagent:collector-cleanup-pending",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "failed launch cleanup",
      cleanup: "keep",
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
      mod.addSubagentRunForTests({
        runId: "run-collector-unsafe-attachments",
        childSessionKey: "agent:main:subagent:collector-unsafe-attachments",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "retain record until attachments are safely removed",
        cleanup: "keep",
        createdAt: Date.now() - 10_000,
        endedAt: Date.now() - 5_000,
        archiveAtMs: Date.now() - 1,
        collect: true,
        groupId: "swarm:unsafe-attachments",
        attachmentsDir,
        attachmentsRootDir,
        collectorCompletion: { status: "done" },
      });

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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "spawn nested child",
      cleanup: "keep",
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
      cleanup: "keep",
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    mod.registerSubagentRun({
      runId: "run-refresh-admission-old",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "capture replacement completion",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    await waitForFast(() => expect(mocks.callGateway).toHaveBeenCalled());
    const entry = mod.getSubagentRunByChildSessionKey(childSessionKey);
    expect(entry).not.toBeNull();
    Object.assign(entry ?? {}, {
      endedAt: Date.now(),
      outcome: { status: "ok" },
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    let finishCapture: ((value: string) => void) | undefined;
    mocks.captureSubagentCompletionReply.mockImplementationOnce(
      async () =>
        await new Promise<string>((resolve) => {
          finishCapture = resolve;
        }),
    );
    mocks.persistSubagentRunsToDisk.mockClear();
    const lifecycleHandler = mocks.onAgentEvent.mock.calls.at(-1)?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deliver terminal completion after restart",
      cleanup: "keep",
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
      const entry = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      expect(entry?.cleanupCompletedAt).toBeTypeOf("number");
    });
  });

  it("keeps killed session timing root-admitted after task finalization", async () => {
    let finishTiming: (() => void) | undefined;
    mocks.patchSessionEntry.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishTiming = resolve;
      });
      return null;
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    const runId = "run-kill-tail-admission";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persist killed session state",
      cleanup: "keep",
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
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish collector cancellation",
      cleanup: "keep",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cancel while gateway launch is unresolved",
      cleanup: "keep",
      createdAt: Date.now(),
      collect: true,
      swarmRunId: runId,
      schedulerSlotId: runId,
      swarmLaunchPending: true,
      execution: { status: "queued" },
      completion: { required: false },
    });

    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();

    expect(mod.settleFailedQueuedSubagentLaunch(runId, "launch response lost")).toBe(true);
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toMatchObject({
      status: "killed",
    });
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("records early structured output through the child session identity", () => {
    const childSessionKey = "agent:main:subagent:early-structured-output";
    mod.addSubagentRunForTests({
      runId: "public-collector-run",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "return structured output immediately",
      cleanup: "keep",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "delete",
      expectsCompletionMessage: true,
      createdAt: now,
    });
    mod.addSubagentRunForTests({
      runId: "run-pending",
      childSessionKey: "agent:main:subagent:pending",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "already delivered task",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: now - 4,
      endedAt: now - 3,
      delivery: { status: "delivered", announcedAt: now - 2, deliveredAt: now - 2 },
      cleanupCompletedAt: now - 1,
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-reconciling",
      childSessionKey: "agent:main:subagent:killed-reconciling",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
          },
        ],
      ]),
    );

    expect(mod.listSessionMaintenanceProtectedSubagentSessionKeys()).toEqual([
      "agent:main:subagent:restored",
    ]);
  });

  it("replays a past-due requester-settle obligation during registry restore", async () => {
    const endedAt = Date.now() - 1_000;
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set("run-settle-restore", {
        runId: "run-settle-restore",
        childSessionKey: "agent:main:subagent:settle-restore",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
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
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();

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

  it("rehydrates persisted collector FIFO queues after registry restore", async () => {
    const now = Date.now();
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    const makeQueuedRun = (runId: string, createdAt: number) => ({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: runId,
      cleanup: "keep" as const,
      collect: true,
      groupId: "logical-group",
      createdAt,
      execution: { status: "queued" as const },
      completion: { required: false },
      queuedLaunch: {
        request: { sessionKey: `agent:main:subagent:${runId}`, idempotencyKey: runId },
        timeoutMs: 1_000,
        schedulerGroupKey: '["agent:main:main","logical-group"]',
        maxConcurrent: 2,
      },
    });
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set("run-queued-one", makeQueuedRun("run-queued-one", now));
      params.runs.set("run-queued-two", makeQueuedRun("run-queued-two", now + 1));
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

    mod.initSubagentRegistry();
    await waitForFast(() => {
      const agentCalls = mocks.callGateway.mock.calls.filter(
        ([request]) => request.method === "agent",
      );
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]?.[0]).toMatchObject({
        params: { idempotencyKey: "run-queued-one" },
      });
    });
    expect(mod.getSubagentRunByRunId("run-queued-one")?.execution?.status).toBe("running");
    expect(mod.getSubagentRunByRunId("gateway-run-one")).toMatchObject({
      runId: "gateway-run-one",
      swarmRunId: "run-queued-one",
      schedulerSlotId: "run-queued-one",
    });
    expect(mod.getSubagentRunByRunId("run-queued-two")?.execution?.status).toBe("queued");
  });

  it("holds a restored FIFO slot until an accepted collector is confirmed stopped", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    const makeQueuedRun = (runId: string, createdAt: number) => ({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: runId,
      cleanup: "keep" as const,
      collect: true,
      groupId: "restore-stop",
      createdAt,
      execution: { status: "queued" as const },
      completion: { required: false },
      queuedLaunch: {
        request: { sessionKey: `agent:main:subagent:${runId}`, idempotencyKey: runId },
        timeoutMs: 1_000,
        schedulerGroupKey: '["agent:main:main","restore-stop"]',
        maxConcurrent: 1,
      },
    });
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set("run-restored-stop-one", makeQueuedRun("run-restored-stop-one", now));
      params.runs.set("run-restored-stop-two", makeQueuedRun("run-restored-stop-two", now + 1));
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-restored-stop-one": { sessionId: "one", updatedAt: now },
      "agent:main:subagent:run-restored-stop-two": { sessionId: "two", updatedAt: now },
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite unavailable after Gateway acceptance");
    });
    let agentCalls = 0;
    let releaseAbort: (() => void) | undefined;
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
        throw new Error("delete unavailable");
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    mod.initSubagentRegistry();
    await waitForFast(() => expect(releaseAbort).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseAbort?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
  });

  it("holds a restored FIFO slot while an indeterminate launch session is deleted", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mocks.getRuntimeConfig.mockReturnValue({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" as const },
    });
    const makeQueuedRun = (runId: string, createdAt: number) => ({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: runId,
      cleanup: "keep" as const,
      collect: true,
      groupId: "restore-delete",
      createdAt,
      execution: { status: "queued" as const },
      completion: { required: false },
      queuedLaunch: {
        request: { sessionKey: `agent:main:subagent:${runId}`, idempotencyKey: runId },
        timeoutMs: 1_000,
        schedulerGroupKey: '["agent:main:main","restore-delete"]',
        maxConcurrent: 1,
      },
    });
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set("run-restored-delete-one", makeQueuedRun("run-restored-delete-one", now));
      params.runs.set("run-restored-delete-two", makeQueuedRun("run-restored-delete-two", now + 1));
      return 2;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:run-restored-delete-one": { sessionId: "one", updatedAt: now },
      "agent:main:subagent:run-restored-delete-two": { sessionId: "two", updatedAt: now },
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

    mod.initSubagentRegistry();
    await waitForFast(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseDelete?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
  });

  it("cleans prepared resources after a restored collector launch fails", async () => {
    const now = Date.now();
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
    }) => {
      params.runs.set("run-queued-failure", {
        runId: "run-queued-failure",
        childSessionKey: "agent:main:subagent:queued-failure",
        requesterSessionKey: "agent:main:main",
        swarmRequesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "fail restored launch",
        cleanup: "keep",
        collect: true,
        groupId: "restore-failure",
        createdAt: now,
        execution: { status: "queued" },
        completion: { required: false },
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-failure" },
          timeoutMs: 1_000,
          schedulerGroupKey: '["agent:main:main","restore-failure"]',
          maxConcurrent: 1,
        },
      });
      return 1;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:queued-failure": { sessionId: "queued-failure", updatedAt: now },
    });
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      return {};
    });

    mod.initSubagentRegistry();

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
      params.runs.set("run-queued-cleanup-retry", {
        runId: "run-queued-cleanup-retry",
        childSessionKey: "agent:main:subagent:queued-cleanup-retry",
        requesterSessionKey: "agent:main:main",
        swarmRequesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "retry failed cleanup",
        cleanup: "keep",
        collect: true,
        groupId: "restore-cleanup-retry",
        createdAt: now,
        execution: { status: "queued" },
        completion: { required: false },
        queuedLaunch: {
          request: { sessionKey: "agent:main:subagent:queued-cleanup-retry" },
          timeoutMs: 1_000,
          schedulerGroupKey: '["agent:main:main","restore-cleanup-retry"]',
          maxConcurrent: 1,
        },
      });
      return 1;
    }) as never);
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:queued-cleanup-retry": {
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

    mod.initSubagentRegistry();

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
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:queued-persist-failure",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "remain queued after sqlite failure",
      cleanup: "keep",
      collect: true,
      groupId: "persist-failure",
      createdAt: Date.now(),
      execution: { status: "queued" },
      completion: { required: false },
      queuedLaunch: {
        request: { sessionKey: "agent:main:subagent:queued-persist-failure" },
        timeoutMs: 1_000,
        schedulerGroupKey: '["agent:main:main","persist-failure"]',
        maxConcurrent: 1,
      },
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });

    expect(() => mod.testing.failQueuedSubagentRun(runId, "launch failed")).toThrow("sqlite busy");

    expect(mod.getSubagentRunByRunId(runId)).toMatchObject({
      execution: { status: "queued" },
      queuedLaunch: { maxConcurrent: 1 },
    });
    expect(mod.getSubagentRunByRunId(runId)?.collectorCompletion).toBeUndefined();
    expect(mod.getSubagentRunByRunId(runId)?.endedAt).toBeUndefined();
  });

  it("requeues durable requester-settle obligations after a worker error", async () => {
    const endedAt = Date.now() - 1_000;
    mod.addSubagentRunForTests({
      runId: "run-settle-retry",
      childSessionKey: "agent:main:subagent:settle-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry requester settle wake",
      cleanup: "keep",
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

  it("schedules orphan recovery instead of terminally failing on recoverable wait transport errors", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        throw new Error("gateway closed (1006): transport close");
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-interrupted-wait",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume after transport close",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expectRecordFields(
        getMockCallArg(mocks.scheduleOrphanRecovery, 0, 0, "orphan recovery"),
        { delayMs: 1_000 },
        "orphan recovery params",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-interrupted-wait");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
  });

  it("does not fall back to network recovery without an instance-bound runtime", async () => {
    mod.testing.setDepsForTest({
      getGatewayRecoveryRuntime: () => undefined,
    });

    mod.scheduleSubagentOrphanRecovery({ delayMs: 1 });
    await Promise.resolve();

    expect(mocks.scheduleOrphanRecovery).not.toHaveBeenCalled();
  });

  it("keeps a debounced recovery bound to the current Gateway runtime", async () => {
    const originalImplementation = mocks.getGatewayRecoveryRuntime.getMockImplementation();
    const firstRuntime = {
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    };
    const replacementRuntime = {
      dispatchAgent: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(),
    };
    mocks.getGatewayRecoveryRuntime.mockReturnValue(firstRuntime);

    try {
      mod.scheduleSubagentOrphanRecovery({ delayMs: 1 });
      await waitForFast(() => expect(mocks.scheduleOrphanRecovery).toHaveBeenCalledOnce());
      const scheduled = requireRecord(
        getMockCallArg(mocks.scheduleOrphanRecovery, 0, 0, "orphan recovery"),
        "orphan recovery params",
      );
      const getGatewayRuntime = scheduled.getGatewayRuntime;
      expect(typeof getGatewayRuntime).toBe("function");

      mocks.getGatewayRecoveryRuntime.mockReturnValue(replacementRuntime);
      mod.scheduleSubagentOrphanRecovery({ delayMs: 1 });

      expect(mocks.scheduleOrphanRecovery).toHaveBeenCalledOnce();
      expect((getGatewayRuntime as () => unknown)()).toBe(replacementRuntime);
    } finally {
      mocks.getGatewayRecoveryRuntime.mockImplementation(originalImplementation!);
    }
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-waiter-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "eventually complete",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-waiter-timeout");
    expect(activeRun?.endedAt).toBeUndefined();
    expect(activeRun?.outcome).toBeUndefined();

    resolveSecondWait({
      status: "ok",
      startedAt: 111,
      endedAt: 222,
    });
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-waiter-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.endedAt).toBe(222);
      expectRecordFields(completedRun?.outcome, { status: "ok" }, "completed run outcome");
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-explicit-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "respect explicit timeout",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
    });
    const activeRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-explicit-timeout");
    expect(activeRun?.endedAt).toBeUndefined();
    expect(activeRun?.outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-explicit-timeout");
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
      expect(completedRun?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.outcome,
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

  it("keeps explicit run timeout terminal when late lifecycle success arrives", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-timeout-late-lifecycle-ok",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout should stay terminal",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-ok");
      expect(completedRun?.endedAt).toBe(startedAt + 1_000);
      expect(completedRun?.outcome?.status).toBe("timeout");
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-timeout-late-lifecycle-ok",
      stream: "lifecycle",
      data: {
        phase: "end",
        endedAt: startedAt + 2_000,
      },
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-ok");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "late lifecycle timeout outcome",
      );
    });
    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps published explicit timeout stable when pre-deadline lifecycle success arrives late", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-timeout-late-lifecycle-predeadline-ok",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "published timeout should stay stable",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-predeadline-ok");
      expect(completedRun?.endedAt).toBe(startedAt + 1_000);
      expect(completedRun?.outcome?.status).toBe("timeout");
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-timeout-late-lifecycle-predeadline-ok",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: startedAt + 10,
        endedAt: startedAt + 500,
      },
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-predeadline-ok");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "stable published timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    expect(mocks.captureSubagentCompletionReply).toHaveBeenCalledTimes(1);
  });

  it("converts first lifecycle success after the explicit run deadline into timeout", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-lifecycle-success-after-deadline",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "post-deadline lifecycle success should timeout",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-lifecycle-success-after-deadline");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-lifecycle-observed-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "respect observed lifecycle start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-lifecycle-observed-start");
      expect(run?.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        run?.outcome,
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
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cleanup lock should not freeze stale timeout",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      createdAt,
      startedAt: createdAt,
      sessionStartedAt: createdAt,
      endedAt: createdAt + 60_000,
      outcome: {
        status: "timeout",
        startedAt: createdAt,
        endedAt: createdAt + 60_000,
        elapsedMs: 60_000,
      },
      cleanupHandled: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const correctedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-cleanup-lock-observed-success");
      expect(correctedRun?.endedAt).toBe(createdAt + 60_000);
      expectRecordFields(
        correctedRun?.outcome,
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    mocks.runSubagentAnnounceFlow.mockResolvedValueOnce(false);
    mod.registerSubagentRun({
      runId: "run-refresh-pending-timeout-payload",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "pending timeout payload should refresh",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      createdAt,
      startedAt: createdAt,
      sessionStartedAt: createdAt,
      endedAt: createdAt + 60_000,
      outcome: {
        status: "timeout",
        startedAt: createdAt,
        endedAt: createdAt + 60_000,
        elapsedMs: 60_000,
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

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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

  it("allows non-explicit published timeouts to be corrected by lifecycle success", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    mod.registerSubagentRun({
      runId: "run-non-explicit-timeout-corrected",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "non-explicit timeout remains correctable",
      cleanup: "keep",
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      startedAt,
      sessionStartedAt: startedAt,
      endedAt: startedAt + 30_000,
      outcome: {
        status: "timeout",
        startedAt,
        endedAt: startedAt + 30_000,
        elapsedMs: 30_000,
      },
      delivery: {
        status: "delivered",
        announcedAt: startedAt + 30_000,
        deliveredAt: startedAt + 30_000,
      },
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-non-explicit-timeout-corrected",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 35_000,
      },
    });

    await waitForFast(() => {
      const correctedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-non-explicit-timeout-corrected");
      expect(correctedRun?.endedAt).toBe(startedAt + 35_000);
      expectRecordFields(
        correctedRun?.outcome,
        {
          status: "ok",
          startedAt,
          endedAt: startedAt + 35_000,
          elapsedMs: 35_000,
        },
        "non-explicit published timeout corrected outcome",
      );
    });
  });

  it("allows pre-deadline lifecycle timeouts to be corrected by lifecycle success", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    mod.registerSubagentRun({
      runId: "run-predeadline-timeout-corrected",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "pre-deadline timeout remains correctable",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).not.toBeNull();
    Object.assign(run ?? {}, {
      startedAt,
      sessionStartedAt: startedAt,
      endedAt: startedAt + 30_000,
      outcome: {
        status: "timeout",
        startedAt,
        endedAt: startedAt + 30_000,
        elapsedMs: 30_000,
      },
      delivery: {
        status: "delivered",
        announcedAt: startedAt + 30_000,
        deliveredAt: startedAt + 30_000,
      },
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-predeadline-timeout-corrected",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt,
        endedAt: startedAt + 35_000,
      },
    });

    await waitForFast(() => {
      const correctedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-predeadline-timeout-corrected");
      expect(correctedRun?.endedAt).toBe(startedAt + 35_000);
      expectRecordFields(
        correctedRun?.outcome,
        {
          status: "ok",
          startedAt,
          endedAt: startedAt + 35_000,
          elapsedMs: 35_000,
        },
        "pre-deadline published timeout corrected outcome",
      );
    });
  });

  it("caps lifecycle timeout events to the explicit run deadline", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-lifecycle-timeout-after-deadline",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "post-deadline lifecycle timeout should cap",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-lifecycle-timeout-after-deadline");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-timeout-late-lifecycle-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "published timeout should ignore late timeout",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-timeout");
      expect(completedRun?.endedAt).toBe(startedAt + 1_000);
      expect(completedRun?.outcome?.status).toBe("timeout");
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-timeout-late-lifecycle-timeout");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-boundary-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "deadline skew should still timeout",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-boundary-timeout");
      expect(waitAttempts).toBe(1);
      expect(completedRun?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        completedRun?.outcome,
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

  it("prefers explicit run timeout over late restored agent.wait success", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    vi.setSystemTime(startedAt + 61_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resumed-late-success", {
        runId: "run-resumed-late-success",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume after explicit timeout",
        cleanup: "keep",
        runTimeoutSeconds: 60,
        createdAt: startedAt,
        startedAt,
        sessionStartedAt: startedAt,
      });
      return 1;
    }) as never);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt,
          endedAt: startedAt + 61_000,
        };
      }
      return {};
    });

    mod.initSubagentRegistry();

    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resumed-late-success");
      expect(completedRun?.endedAt).toBe(startedAt + 60_000);
      expectRecordFields(
        completedRun?.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 60_000,
          elapsedMs: 60_000,
        },
        "late restored wait success timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("uses observed agent.wait start time when applying explicit run deadline", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt + 65_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resumed-observed-start", {
        runId: "run-resumed-observed-start",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "respect observed start",
        cleanup: "keep",
        runTimeoutSeconds: 60,
        createdAt,
        startedAt: createdAt,
        sessionStartedAt: createdAt,
      });
      return 1;
    }) as never);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: observedStartedAt,
          endedAt: createdAt + 65_000,
        };
      }
      return {};
    });

    mod.initSubagentRegistry();

    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resumed-observed-start");
      expect(completedRun?.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        completedRun?.outcome,
        {
          status: "ok",
          startedAt: observedStartedAt,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "observed start success outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        status: "done",
        startedAt: sessionStartedAt,
        updatedAt: createdAt + 65_000,
        endedAt: createdAt + 65_000,
      },
    });

    mod.registerSubagentRun({
      runId: "run-ok-session-store-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "respect restored success start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-ok-session-store-start");
      expect(completedRun?.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        completedRun?.outcome,
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

  it("does not terminally time out plain agent.wait timeouts before the observed run deadline", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt + 61_000);
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        return {
          status: "timeout",
          startedAt: observedStartedAt,
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: createdAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-plain-timeout-observed-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do not timeout before observed start deadline",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    let run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-plain-timeout-observed-start");
    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-plain-timeout-observed-start");
      expect(run?.endedAt).toBeUndefined();
      expect(run?.outcome).toBeUndefined();
      expect(run?.startedAt).toBe(observedStartedAt);
    });

    vi.setSystemTime(observedStartedAt + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-plain-timeout-observed-start");
      expect(run?.endedAt).toBe(observedStartedAt + 60_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt: observedStartedAt,
          endedAt: observedStartedAt + 60_000,
          elapsedMs: 60_000,
        },
        "observed start plain wait timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("uses running session-store start time for plain agent.wait timeouts", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt);
    let waitAttempts = 0;
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        waitAttempts += 1;
        if (waitAttempts === 1) {
          vi.setSystemTime(createdAt + 61_000);
        }
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: createdAt + 61_000,
        status: "running",
        startedAt: sessionStartedAt,
      },
    });

    mod.registerSubagentRun({
      runId: "run-plain-timeout-session-store-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do not timeout before session store start deadline",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-plain-timeout-session-store-start");
      expect(waitAttempts).toBeGreaterThanOrEqual(1);
      expect(run?.endedAt).toBeUndefined();
      expect(run?.outcome).toBeUndefined();
      expect(run?.startedAt).toBe(sessionStartedAt);
    });

    vi.setSystemTime(sessionStartedAt + 60_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-plain-timeout-session-store-start");
      expect(run?.endedAt).toBe(sessionStartedAt + 60_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt: sessionStartedAt,
          endedAt: sessionStartedAt + 60_000,
          elapsedMs: 60_000,
        },
        "session store start plain wait timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("prefers agent.wait start time over stale session-store start time", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt + 61_000);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "timeout",
          startedAt: observedStartedAt,
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        status: "done",
        startedAt: createdAt,
        updatedAt: createdAt + 65_000,
        endedAt: createdAt + 65_000,
      },
    });

    mod.registerSubagentRun({
      runId: "run-wait-start-over-session-store-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "prefer wait observed start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-wait-start-over-session-store-start");
      expect(run?.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "ok",
          startedAt: observedStartedAt,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "wait observed start beats stale session store start",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("uses session-store start time when agent.wait times out without a start", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        vi.setSystemTime(createdAt + 61_000);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        status: "done",
        startedAt: sessionStartedAt,
        updatedAt: createdAt + 65_000,
        endedAt: createdAt + 65_000,
      },
    });

    mod.registerSubagentRun({
      runId: "run-session-store-start-after-wait-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "use session store observed start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-session-store-start-after-wait-timeout");
      expect(run?.endedAt).toBe(createdAt + 65_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "ok",
          startedAt: sessionStartedAt,
          endedAt: createdAt + 65_000,
          elapsedMs: 55_000,
        },
        "session store observed start beats stale registry start",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("ignores stale session-store start time for fresh terminal completions", async () => {
    const createdAt = Date.parse("2026-03-24T12:00:00Z");
    const staleSessionStartedAt = createdAt - 60_000;
    vi.setSystemTime(createdAt);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        vi.setSystemTime(createdAt + 61_000);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        status: "done",
        startedAt: staleSessionStartedAt,
        updatedAt: createdAt + 30_000,
        endedAt: createdAt + 30_000,
      },
    });

    mod.registerSubagentRun({
      runId: "run-ignore-stale-session-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ignore stale session store start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-ignore-stale-session-start");
      expect(run?.endedAt).toBe(createdAt + 30_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "ok",
          startedAt: createdAt,
          endedAt: createdAt + 30_000,
          elapsedMs: 30_000,
        },
        "fresh terminal completion ignores stale session start",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("applies explicit timeout to terminal session rows without startedAt", async () => {
    const createdAt = Date.parse("2026-03-24T12:00:00Z");
    vi.setSystemTime(createdAt);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        vi.setSystemTime(createdAt + 61_000);
        return { status: "timeout" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        status: "done",
        updatedAt: createdAt + 61_000,
        endedAt: createdAt + 61_000,
      },
    });

    mod.registerSubagentRun({
      runId: "run-session-row-no-start-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "terminal row without start still honors timeout",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-session-row-no-start-timeout");
      expect(run?.endedAt).toBe(createdAt + 60_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt: createdAt,
          endedAt: createdAt + 60_000,
          elapsedMs: 60_000,
        },
        "terminal session row without start timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("caps restored waits to the remaining explicit run timeout", async () => {
    const startedAt = Date.parse("2026-03-24T11:59:00Z");
    const runTimeoutSeconds = 60;
    vi.setSystemTime(startedAt + 59_000);
    mocks.resolveAgentTimeoutMs.mockReturnValue(60_000);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resumed-near-deadline", {
        runId: "run-resumed-near-deadline",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume near explicit timeout",
        cleanup: "keep",
        runTimeoutSeconds,
        createdAt: startedAt,
        startedAt,
        sessionStartedAt: startedAt,
      });
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

    mod.initSubagentRegistry();

    await waitForFast(() => {
      expect(waitTimeouts).toEqual([1_000]);
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resumed-near-deadline");
      expect(completedRun?.endedAt).toBe(startedAt + 60_000);
      expectRecordFields(
        completedRun?.outcome,
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

  it("records explicit agent.wait cancellation before session timing is persisted", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "timeout",
          startedAt: 111,
          endedAt: 222,
          stopReason: "rpc",
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 1,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-terminal-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "time out terminally",
      cleanup: "keep",
    });

    // Main defers timed-out lifecycle completion behind a retry grace timer.
    await vi.advanceTimersByTimeAsync(20_000);

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-terminal-timeout");
      expect(run?.endedAt).toBe(222);
      expectRecordFields(
        run?.outcome,
        { status: "error", error: "subagent run terminated" },
        "terminal cancellation outcome",
      );
    });
    // Announce delivery for wait-terminal completions is owned by main's
    // cancellation-evidence reconciliation and covered by its own flows;
    // this test pins the audit-relevant ordering (outcome + endedAt) only.
  });

  it("caps terminal agent.wait timeouts to the explicit run deadline", async () => {
    const startedAt = Date.now();
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 2_000,
          stopReason: "rpc",
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: startedAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-terminal-timeout-capped",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cap terminal timeout",
      cleanup: "keep",
      runTimeoutSeconds: 1,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-terminal-timeout-capped");
      expect(run?.endedAt).toBe(startedAt + 1_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt,
          endedAt: startedAt + 1_000,
          elapsedMs: 1_000,
        },
        "capped terminal timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("uses observed agent.wait start time when capping terminal timeout", async () => {
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const observedStartedAt = createdAt + 10_000;
    vi.setSystemTime(createdAt + 75_000);
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "timeout",
          startedAt: observedStartedAt,
          endedAt: createdAt + 75_000,
          stopReason: "rpc",
        };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: createdAt,
        status: "running",
      },
    });

    mod.registerSubagentRun({
      runId: "run-terminal-timeout-observed-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cap timeout using observed start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-terminal-timeout-observed-start");
      expect(run?.endedAt).toBe(observedStartedAt + 60_000);
      expectRecordFields(
        run?.outcome,
        {
          status: "timeout",
          startedAt: observedStartedAt,
          endedAt: observedStartedAt + 60_000,
          elapsedMs: 60_000,
        },
        "observed start capped terminal timeout outcome",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: staleEndedAt,
        status: "done",
        startedAt: staleEndedAt - 100,
        endedAt: staleEndedAt,
      },
    });

    mod.registerSubagentRun({
      runId: "run-reactivated-timeout",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new run after stale terminal row",
      cleanup: "keep",
    });

    await waitForFast(() => {
      expect(waitAttempts).toBeGreaterThanOrEqual(2);
    });
    const activeRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-reactivated-timeout");
    expect(activeRun?.endedAt).toBeUndefined();
    expect(activeRun?.outcome).toBeUndefined();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    resolveSecondWait({
      status: "ok",
      startedAt: Date.parse("2026-03-24T12:00:01Z"),
      endedAt: Date.parse("2026-03-24T12:00:02Z"),
    });
    await waitForFast(() => {
      const completedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-reactivated-timeout");
      expectRecordFields(completedRun?.outcome, { status: "ok" }, "reactivated run outcome");
    });
  });

  it("keeps sessions_yield-ended subagent runs paused instead of announcing no output", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 111,
          endedAt: 222,
          stopReason: "end_turn",
          livenessState: "paused",
          yielded: true,
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-yield-paused",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait for child continuation",
      cleanup: "keep",
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-yield-paused");
      expect(run?.endedAt).toBe(222);
      expect(run?.pauseReason).toBe("sessions_yield");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(mod.countPendingDescendantRuns("agent:main:main")).toBe(1);

    expect(
      mod.replaceSubagentRunAfterSteer({
        previousRunId: "run-yield-paused",
        nextRunId: "run-yield-continuation",
      }),
    ).toBe(true);
    const replacement = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-yield-continuation");
    expect(replacement?.runId).toBe("run-yield-continuation");
    expect(replacement?.pauseReason).toBeUndefined();
    expect(replacement?.endedAt).toBeUndefined();
  });

  it("ignores a late yield lifecycle event after the paused run is killed", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    const runId = "run-yield-killed-before-late-event";
    const childSessionKey = "agent:main:subagent:yield-killed-before-late-event";
    mod.registerSubagentRun({
      runId,
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stop while paused",
      cleanup: "keep",
    });
    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls.at(-1) as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      endedAt: 222,
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
      endedAt: 222,
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      cleanupCompletedAt: killedCleanupAt,
      suppressAnnounceReason: "killed",
    });
    expect(afterLateYield?.pauseReason).toBeUndefined();
  });

  it("accepts an authoritative late yield after non-kill cleanup started", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    const runId = "run-yield-after-success-cleanup";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:yield-after-success-cleanup",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "pause after terminal projection",
      cleanup: "keep",
    });
    const lifecycleHandler = (
      mocks.onAgentEvent.mock.calls.at(-1) as unknown as
        | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
        | undefined
    )?.[0];
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
    expect(lifecycleHandler).toBeTypeOf("function");
    expect(run).toBeDefined();
    Object.assign(run!, {
      endedAt: 222,
      endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
      outcome: { status: "ok" as const },
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
      endedAt: 333,
      pauseReason: "sessions_yield",
      cleanupHandled: false,
      delivery: { status: "pending" },
    });
    expect(run?.endedReason).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
    expect(run?.cleanupCompletedAt).toBeUndefined();
  });

  it("keeps yield terminals paused when the lifecycle event also signals abort (#92448)", async () => {
    // sessions_yield ends the turn by aborting the run signal, so a depth-1
    // subagent's yield terminal can arrive carrying yielded plus aborted (or
    // stopReason="aborted"). The event handler must still pause the run, not
    // settle it `cancelled` and deliver a false notice to the requester.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    const cases = [
      { runId: "run-yield-stopreason-aborted", extra: { stopReason: "aborted" } },
      { runId: "run-yield-aborted-flag", extra: { aborted: true } },
    ];

    for (const testCase of cases) {
      mod.registerSubagentRun({
        runId: testCase.runId,
        childSessionKey: `agent:main:subagent:${testCase.runId}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "wait for child continuation",
        cleanup: "keep",
      });

      const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
        mocks.onAgentEvent.mock.calls.length - 1
      ] as unknown as
        | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
        | undefined;
      const lifecycleHandler = lastOnAgentEventCall?.[0];
      expect(lifecycleHandler).toBeTypeOf("function");

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
        const run = mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === testCase.runId);
        expect(run?.pauseReason).toBe("sessions_yield");
        expect(run?.outcome?.status).not.toBe("error");
      });
    }

    // Paused, never killed → no farewell/cancellation notice reaches the requester.
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending grace timer when a yield follows an intermediate aborted terminal (#92448)", async () => {
    // An earlier aborted terminal schedules a deferred kill grace timer; a
    // following yield must clear it, or it fires and settles the now-paused run.
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait for child continuation",
      cleanup: "keep",
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    // Advancing well past the 15s grace window must not undo the pause.
    await vi.advanceTimersByTimeAsync(60_000);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.outcome?.status).not.toBe("error");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("cancels a pending timeout grace timer when the run is explicitly killed", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    const runId = "run-killed-after-pending-timeout";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:killed-after-pending-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stop during timeout grace",
      cleanup: "keep",
    });

    const lifecycleHandler = (
      mocks.onAgentEvent.mock.calls.at(-1) as unknown as
        | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
        | undefined
    )?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId,
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    expect(mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
    expect(run).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      outcome: { status: "error", error: "manual kill" },
    });
    expect(run?.outcome?.status).not.toBe("timeout");
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return waitResult;
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-wait-yield-after-pending-timeout",
      childSessionKey: "agent:main:subagent:pending-wait-timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "wait for child continuation through wait",
      cleanup: "keep",
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-wait-yield-after-pending-timeout",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 111, endedAt: 222, aborted: true },
    });
    resolveWait({ status: "ok", startedAt: 111, endedAt: 333, yielded: true });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-wait-yield-after-pending-timeout");
      expect(run?.pauseReason).toBe("sessions_yield");
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-wait-yield-after-pending-timeout");
    expect(run?.pauseReason).toBe("sessions_yield");
    expect(run?.outcome?.status).not.toBe("timeout");
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("announces blocked agent.wait snapshots as errors instead of success", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 100,
          endedAt: 250,
          livenessState: "blocked",
          error: "Context overflow: prompt too large for the model.",
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-blocked-wait",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "overflow wait",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "blocked wait announce"),
      { childRunId: "run-blocked-wait" },
      "blocked wait announce params",
    );
    expectRecordFields(
      announceParams.outcome,
      {
        status: "error",
        error: "Context overflow: prompt too large for the model.",
        startedAt: 100,
        endedAt: 250,
        elapsedMs: 150,
      },
      "blocked wait announce outcome",
    );

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-blocked-wait");
    expect(run?.endedReason).toBe("subagent-error");
    expect(run?.outcome?.status).toBe("error");
  });

  it("announces provider hard timeout wait snapshots as timeouts despite blocked metadata", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "error",
          startedAt: 100,
          endedAt: 250,
          livenessState: "blocked",
          timeoutPhase: "provider",
          providerStarted: true,
          error: "model timed out",
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-blocked-hard-timeout-wait",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "provider timeout wait",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => {
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
    });
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "hard timeout wait announce"),
      { childRunId: "run-blocked-hard-timeout-wait" },
      "hard timeout wait announce params",
    );
    expectRecordFields(
      announceParams.outcome,
      {
        status: "timeout",
        startedAt: 100,
        endedAt: 250,
        elapsedMs: 150,
      },
      "hard timeout wait announce outcome",
    );

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-blocked-hard-timeout-wait");
    expect(run?.endedReason).toBe("subagent-complete");
    expect(run?.outcome?.status).toBe("timeout");
  });

  it("publishes aborted agent.wait snapshots only after killed reconciliation", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return {
          status: "ok",
          startedAt: 100,
          endedAt: 250,
          stopReason: "aborted",
        };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-aborted-wait",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "aborted wait",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-aborted-wait");
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    const persistedStartedAt = Date.parse("2026-03-24T11:58:00Z");
    const persistedEndedAt = persistedStartedAt + 111;
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: persistedEndedAt,
        status: "done",
        startedAt: persistedStartedAt,
        endedAt: persistedEndedAt,
        runtimeMs: 111,
      },
    });

    vi.setSystemTime(persistedStartedAt - 1);
    mod.registerSubagentRun({
      runId: "run-stale-terminal",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "settle from persisted terminal state",
      cleanup: "keep",
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

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-stale-terminal");
    expect(run?.endedAt).toBe(persistedEndedAt);
    expectRecordFields(
      run?.outcome,
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: endedAt,
        status: "done",
        startedAt,
        endedAt,
      },
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-with-persisted-completion",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recover persisted completion",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      endedAt: killedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt },
      cleanupHandled: true,
      cleanupCompletedAt: killedAt,
    });

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-with-persisted-completion");
      expect(run?.endedReason).toBe(SUBAGENT_ENDED_REASON_COMPLETE);
      expect(run?.outcome).toMatchObject({ status: "ok", startedAt, endedAt });
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
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: runId,
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey,
          runId,
          task: "repair task-first completion",
          deliveryStatus: "pending",
          startedAt,
          lastEventAt: startedAt,
        }),
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
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "repair task-first completion",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        endedAt: killedAt,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
      });

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((candidate) => candidate.runId === runId);
        expect(run).toMatchObject({
          endedAt: completedAt,
          endedReason: expectedReason,
          outcome: { ...expectedOutcome, startedAt, endedAt: completedAt },
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
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: taskRunId,
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey,
          runId: taskRunId,
          task: "finish after steer",
          deliveryStatus: "pending",
          startedAt: originalStartedAt,
          lastEventAt: originalStartedAt,
        }),
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
      mod.addSubagentRunForTests({
        runId,
        taskRunId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "finish after steer",
        cleanup: "keep",
        generation: 2,
        createdAt: replacementStartedAt,
        startedAt: replacementStartedAt,
        sessionStartedAt: originalStartedAt,
        runTimeoutSeconds: 10,
        endedAt: killedAt,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
      });

      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((candidate) => candidate.runId === runId);
        expect(run).toMatchObject({
          endedAt: completedAt,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          outcome: { status: "ok", startedAt: replacementStartedAt, endedAt: completedAt },
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
      const task = createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        task: "retry completion projection",
        deliveryStatus: "pending",
        startedAt,
        lastEventAt: startedAt,
      });
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
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "retry completion projection",
        cleanup: "keep",
        createdAt: startedAt,
        startedAt,
        endedAt: killedAt,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
      });

      await mod.testing.sweepOnceForTests();

      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      expect(run).toMatchObject({
        endedAt: killedAt,
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
    mod.addSubagentRunForTests({
      runId: "run-opaque-killed-with-persisted-completion",
      childSessionKey: "agent:main:subagent:opaque-child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recover opaque persisted completion",
      cleanup: "keep",
      createdAt: startedAt,
      startedAt,
      endedAt: killedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt },
      cleanupHandled: true,
      cleanupCompletedAt: killedAt,
    });

    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-opaque-killed-with-persisted-completion");
      expect(run).toMatchObject({
        endedAt,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        outcome: { status: "ok", startedAt, endedAt },
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
    mod.addSubagentRunForTests({
      runId: "run-opaque-finalizer-miss",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "bound opaque finalizer failure",
      cleanup: "keep",
      expectsCompletionMessage: false,
      createdAt: startedAt,
      startedAt,
      endedAt: killedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt },
      cleanupHandled: true,
      cleanupCompletedAt: killedAt,
    });

    await mod.testing.sweepOnceForTests();

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-opaque-finalizer-miss");
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
          sessionId: "sess-stable-cancellation",
          updatedAt: completedAt,
          status: "done",
          startedAt,
          endedAt: completedAt,
        },
      });
      expect(
        createRunningTaskRun({
          runtime: "subagent",
          sourceId: runId,
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey,
          runId,
          task: "preserve operator cancellation",
          deliveryStatus: "pending",
          startedAt,
          lastEventAt: startedAt,
        }),
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
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve operator cancellation",
        cleanup: "delete",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        startedAt,
        endedAt: killedAt,
        endedReason: "subagent-killed",
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
        archiveAtMs: Date.now(),
      });

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
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        task: "preserve earlier completion",
        deliveryStatus: "pending",
        startedAt,
        lastEventAt: startedAt,
      });
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
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve earlier completion",
        cleanup: "keep",
        expectsCompletionMessage: false,
        createdAt: startedAt,
        startedAt,
        runTimeoutSeconds: 8,
        endedAt: killedAt,
        endedReason: "subagent-killed",
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
      });

      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === runId);
        expect(run).toMatchObject({
          endedAt: timeoutAt,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          outcome: { status: "timeout", startedAt, endedAt: timeoutAt },
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
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        task: "cancel during result capture",
        deliveryStatus: "pending",
        startedAt,
        lastEventAt: startedAt,
      });
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
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "cancel during result capture",
        cleanup: "keep",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        startedAt,
        endedAt: killedAt,
        endedReason: "subagent-killed",
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt },
        cleanupHandled: true,
        cleanupCompletedAt: killedAt,
      });

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
      const remainingRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === runId);
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
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        task: "complete between yield and kill",
        deliveryStatus: "pending",
        startedAt,
        lastEventAt: startedAt,
      });
      mod.addSubagentRunForTests({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "complete between yield and kill",
        cleanup: "keep",
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
      const killedRun = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === runId);
      expect(killedRun).toMatchObject({
        endedAt: yieldedAt,
        cleanupCompletedAt: killedAt,
        endedReason: SUBAGENT_ENDED_REASON_KILLED,
      });

      vi.setSystemTime(killedAt + 5 * 60_000);
      await mod.testing.sweepOnceForTests();

      await waitForFast(() => {
        const run = mod
          .listSubagentRunsForRequester("agent:main:main")
          .find((entry) => entry.runId === runId);
        expect(run).toMatchObject({
          endedAt: completedAt,
          endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
          outcome: { status: "ok", startedAt, endedAt: completedAt },
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
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: endedAt,
        status: "killed",
        startedAt,
        endedAt,
      },
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-with-persisted-kill",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire persisted kill",
      cleanup: "keep",
      expectsCompletionMessage: false,
      createdAt: startedAt,
      startedAt,
      endedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: endedAt },
      cleanupHandled: true,
      cleanupCompletedAt: endedAt,
    });

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
    mod.addSubagentRunForTests({
      runId: "run-requester-stop-suppressed",
      childSessionKey: "agent:main:subagent:requester-stop-suppressed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do not re-inject after stop",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: killedAt - 60_000,
      endedAt: killedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt, suppressTaskDelivery: true },
      cleanupHandled: true,
      cleanupCompletedAt: killedAt,
    });

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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    mod.addSubagentRunForTests({
      runId: "run-released-successor-old",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retire only old ownership",
      cleanup: "delete",
      createdAt: killedAt - 60_000,
      endedAt: killedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt },
      cleanupHandled: true,
      cleanupCompletedAt: killedAt,
    });
    mod.registerSubagentRun({
      runId: "run-released-successor-new",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new generation",
      cleanup: "keep",
    });
    const oldRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-released-successor-old");
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
    mod.addSubagentRunForTests({
      runId: "run-old-tombstone",
      childSessionKey: "agent:main:subagent:reused",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old generation",
      cleanup: "delete",
      createdAt: oldStartedAt,
      startedAt: oldStartedAt,
      sessionStartedAt: oldStartedAt,
      endedAt: oldEndedAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: oldEndedAt },
      cleanupHandled: true,
      cleanupCompletedAt: oldEndedAt,
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
    });
    mod.addSubagentRunForTests({
      runId: "run-new-generation",
      childSessionKey: "agent:main:subagent:reused",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new generation",
      cleanup: "keep",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation");
    expect(newRun).toBeDefined();
    expect(newRun?.endedAt).toBeUndefined();
    expect(newRun?.outcome).toBeUndefined();
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
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: "run-old-no-start",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId: "run-old-no-start",
        task: "keep old cancellation canonical",
        deliveryStatus: "pending",
        startedAt: oldStartedAt,
        lastEventAt: oldStartedAt,
      });
      finalizeTaskRunByRunId({
        runId: "run-old-no-start",
        runtime: "subagent",
        sessionKey: childSessionKey,
        status: "cancelled",
        endedAt: oldKilledAt,
        lastEventAt: oldKilledAt,
        error: SUBAGENT_KILL_TASK_ERROR,
      });
      mod.addSubagentRunForTests({
        runId: "run-old-no-start",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "keep old cancellation canonical",
        cleanup: "keep",
        createdAt: oldStartedAt,
        startedAt: oldStartedAt,
        endedAt: oldKilledAt,
        endedReason: "subagent-killed",
        outcome: { status: "error", error: "manual kill" },
        suppressAnnounceReason: "killed",
        killReconciliation: { killedAt: oldKilledAt },
        cleanupHandled: true,
        cleanupCompletedAt: oldKilledAt,
        runTimeoutSeconds: 60,
      });
      mod.addSubagentRunForTests({
        runId: "run-new-no-start",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "new generation without persisted start time",
        cleanup: "keep",
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

  it("does not restore session-write ownership after a successor is released", async () => {
    const childSessionKey = "agent:main:subagent:released-timing-owner";
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    mocks.loadSessionStore.mockReturnValue({
      [childSessionKey]: { sessionId: "sess-released-timing-owner", updatedAt: 1 },
    });
    let releaseTimingWrite: (() => void) | undefined;
    let timingWriteStarted: (() => void) | undefined;
    const timingWriteStartedPromise = new Promise<void>((resolve) => {
      timingWriteStarted = resolve;
    });
    const timingWriteFinished = new Promise<void>((resolveFinished) => {
      mocks.patchSessionEntry.mockImplementationOnce(async (scope, update) => {
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old timing owner",
      cleanup: "keep",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new timing owner",
      cleanup: "keep",
    });
    mod.releaseSubagentRun("run-released-timing-new");
    releaseTimingWrite?.();
    await timingWriteFinished;

    const oldRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-released-timing-old");
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
    mod.addSubagentRunForTests({
      runId: "run-old-completed-tombstone",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old completed generation",
      cleanup: "delete",
      createdAt: oldStartedAt,
      startedAt: oldStartedAt,
      sessionStartedAt: oldStartedAt,
      endedAt: oldKilledAt,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: oldKilledAt },
      cleanupHandled: true,
      cleanupCompletedAt: oldKilledAt,
    });
    mod.addSubagentRunForTests({
      runId: "run-new-generation-after-completion",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new generation",
      cleanup: "keep",
      createdAt: newStartedAt,
      startedAt: newStartedAt,
      sessionStartedAt: newStartedAt,
    });

    await mod.testing.sweepOnceForTests();

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs.some((entry) => entry.runId === "run-old-completed-tombstone")).toBe(false);
    const newRun = runs.find((entry) => entry.runId === "run-new-generation-after-completion");
    expect(newRun).toBeDefined();
    expect(newRun?.endedAt).toBeUndefined();
    expect(newRun?.outcome).toBeUndefined();
    expect(
      mocks.callGateway.mock.calls.some(
        ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
      ),
    ).toBe(false);
    expect(
      mocks.patchSessionEntry.mock.calls.some(
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    const createdAt = Date.parse("2026-03-24T11:59:00Z");
    const sessionStartedAt = createdAt + 10_000;
    const sessionEndedAt = createdAt + 65_000;
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: sessionEndedAt,
        status: "done",
        startedAt: sessionStartedAt,
        endedAt: sessionEndedAt,
      },
    });

    vi.setSystemTime(createdAt);
    mod.registerSubagentRun({
      runId: "run-sweep-session-start",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sweep should respect session store start",
      cleanup: "keep",
      runTimeoutSeconds: 60,
    });

    vi.setSystemTime(createdAt + 120_000);
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-sweep-session-start");
      expect(run?.endedAt).toBe(sessionEndedAt);
      expectRecordFields(
        run?.outcome,
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

  it("requeues orphan recovery instead of keeping restart-aborted stale runs stuck as running", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: 333,
        status: "running",
        abortedLastRun: true,
      },
    });

    mod.registerSubagentRun({
      runId: "run-stale-aborted",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "resume after restart",
      cleanup: "keep",
    });

    vi.setSystemTime(new Date("2026-03-24T12:02:00Z"));
    await mod.testing.sweepOnceForTests();

    await waitForFast(() => {
      expectRecordFields(
        getMockCallArg(mocks.scheduleOrphanRecovery, 0, 0, "orphan recovery"),
        { delayMs: 1_000 },
        "orphan recovery params",
      );
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-stale-aborted");
    expect(run?.endedAt).toBeUndefined();
    expect(run?.outcome).toBeUndefined();
  });

  it("completes a registered run across timing persistence, lifecycle status, and announce cleanup", async () => {
    mod.registerSubagentRun({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " quietchat ", accountId: " acct-1 " },
      requesterDisplayKey: "main",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry durable completion",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-retry-durable-completion");
      expect(run).toMatchObject({
        endedAt: 222,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        outcome: { status: "ok", startedAt: 111, endedAt: 222 },
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
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "must fail closed",
        cleanup: "keep",
      }),
    ).toThrowError("disk full");

    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-durability-required"),
    ).toBeUndefined();
  });

  it("retains an already-running replacement when its durable write fails", () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    mod.registerSubagentRun({
      runId: "run-replacement-persist-old",
      childSessionKey: "agent:main:subagent:replacement-persist",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "keep live successor tracked",
      cleanup: "keep",
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(
      mod.replaceSubagentRunAfterSteer({
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve old ownership",
      cleanup: "keep",
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
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "new generation",
        cleanup: "keep",
      }),
    ).toThrowError("disk full");

    const oldRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-registration-rollback-old");
    expect(oldRun?.killReconciliation).toEqual({ killedAt: Date.now() - 500 });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .some((entry) => entry.runId === "run-registration-rollback-new"),
    ).toBe(false);
  });

  it("rolls back a killed tombstone when its durable registry write fails", () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    const runId = "run-kill-persist-failure";
    mod.registerSubagentRun({
      runId,
      childSessionKey: "agent:main:subagent:kill-persist-failure",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "keep kill state atomic",
      cleanup: "keep",
    });
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    expect(() => mod.markSubagentRunTerminated({ runId, reason: "manual kill" })).toThrowError(
      "disk full",
    );

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === runId);
    expect(run?.endedAt).toBeUndefined();
    expect(run?.endedReason).toBeUndefined();
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({ status: "running" });
  });

  it("continues completion announce cleanup when lifecycle cleanup fails", async () => {
    mocks.cleanupBrowserSessionsForLifecycleEnd.mockRejectedValueOnce(
      new Error("browser cleanup unavailable"),
    );

    mod.registerSubagentRun({
      runId: "run-cleanup-warning",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish despite cleanup warning",
      cleanup: "keep",
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

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-cleanup-warning");
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
      mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
        if (request.method === "agent.wait") {
          return { status: "pending" };
        }
        return {};
      });

      mod.registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task,
        cleanup: "keep",
        expectsCompletionMessage: true,
      });

      const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
        mocks.onAgentEvent.mock.calls.length - 1
      ] as unknown as
        | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
        | undefined;
      const lifecycleHandler = lastOnAgentEventCall?.[0];
      expect(lifecycleHandler).toBeTypeOf("function");

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

      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === runId);
      expect(run?.endedReason).toBe("subagent-error");
      expect(run?.outcome?.status).toBe("error");
    },
  );

  it("publishes aborted lifecycle end events only after killed reconciliation", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-aborted-end",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "aborted task",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-aborted-end",
      stream: "lifecycle",
      data: {
        phase: "start",
        startedAt: 10,
      },
    });
    lifecycleHandler?.({
      runId: "run-aborted-end",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 10,
        endedAt: 20,
        aborted: true,
        livenessState: "blocked",
        stopReason: "aborted",
      },
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-aborted-end");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
    const announceParams = expectRecordFields(
      getMockCallArg(mocks.runSubagentAnnounceFlow, 0, 0, "aborted announce"),
      { childRunId: "run-aborted-end" },
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

    await waitForFast(() => {
      expect(
        mod
          .listSubagentRunsForRequester("agent:main:main")
          .some((entry) => entry.runId === "run-aborted-end"),
      ).toBe(false);
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
  });

  it("publishes restart lifecycle end events only after killed reconciliation", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-restart-end",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "restart task",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    lifecycleHandler?.({
      runId: "run-restart-end",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 10,
        endedAt: 20,
        aborted: true,
        stopReason: "restart",
      },
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-restart-end");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.outcome?.status).toBe("error");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
  });

  it("publishes restart lifecycle error events only after killed reconciliation", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-restart-error",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "restart error task",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    lifecycleHandler?.({
      runId: "run-restart-error",
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 10,
        endedAt: 20,
        error: "ACP turn failed before completion",
        aborted: true,
        stopReason: "restart",
      },
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-restart-error");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.outcome?.status).toBe("error");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(1));
  });

  it("finishes canonical killed cleanup when its best-effort hook fails", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    mocks.ensureRuntimePluginsLoaded.mockRejectedValueOnce(
      new Error("runtime unavailable during killed hook"),
    );

    mod.registerSubagentRun({
      runId: "run-killed-recovery",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "killed recovery test",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-recovery");
      expect(run?.outcome?.status).toBe("error");
      expect(run?.endedReason).toBe("subagent-killed");
      expect(run?.suppressAnnounceReason).toBe("killed");
    });
    expect(mocks.ensureRuntimePluginsLoaded).not.toHaveBeenCalled();

    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalled();
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
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "keep me past the session ttl",
      cleanup: "keep",
      spawnMode: "run",
    });

    await waitForFast(() => {
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-keep-survives-ttl");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });

    vi.setSystemTime(new Date(Date.parse("2026-03-24T12:00:00Z") + 10 * 60_000));
    await mod.testing.sweepOnceForTests();

    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-keep-survives-ttl");
    expect(run?.runId).toBe("run-keep-survives-ttl");
  });

  it("retries completion hooks before resuming ended cleanup", async () => {
    mocks.ensureRuntimePluginsLoaded.mockRejectedValueOnce(new Error("runtime unavailable"));

    mod.registerSubagentRun({
      runId: "run-hook-retry",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish after hook retry",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded.mock.calls.length).toBeGreaterThanOrEqual(2);
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-hook-retry");
      expect(run?.cleanupCompletedAt).toBeTypeOf("number");
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });

  it("suppresses stale timeout announces when the same child run later finishes successfully", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });

    mod.registerSubagentRun({
      runId: "run-timeout-then-ok",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout retry",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });

    const lastOnAgentEventCall = mocks.onAgentEvent.mock.calls[
      mocks.onAgentEvent.mock.calls.length - 1
    ] as unknown as
      | [(evt: { runId: string; stream: string; data: Record<string, unknown> }) => void]
      | undefined;
    const lifecycleHandler = lastOnAgentEventCall?.[0];
    expect(lifecycleHandler).toBeTypeOf("function");

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
      data: { phase: "end", endedAt: 1_250 },
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

  it("emits the canonical ended hook when plugin loading overlaps a newer completion", async () => {
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "pending" } : {},
    );
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    let releaseOldPluginLoad: (() => void) | undefined;
    const oldPluginLoad = new Promise<void>((resolve) => {
      releaseOldPluginLoad = resolve;
    });
    mocks.ensureRuntimePluginsLoaded.mockImplementationOnce(async () => {
      await oldPluginLoad;
    });

    mod.registerSubagentRun({
      runId: "run-hook-timeout-then-ok",
      childSessionKey: "agent:main:subagent:hook-timeout-then-ok",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "publish only the canonical hook",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const lifecycleHandler = mocks.onAgentEvent.mock.calls.at(-1)?.[0] as
      | ((evt: { runId: string; stream: string; data: Record<string, unknown> }) => void)
      | undefined;
    expect(lifecycleHandler).toBeTypeOf("function");

    lifecycleHandler?.({
      runId: "run-hook-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 200, aborted: true },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await waitForFast(() => expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledTimes(1));

    lifecycleHandler?.({
      runId: "run-hook-timeout-then-ok",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 100, endedAt: 250 },
    });
    await waitForFast(() => expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1));
    releaseOldPluginLoad?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    expectRecordFields(
      getMockCallArg(mocks.runSubagentEnded, 0, 0, "canonical ended hook"),
      { reason: "subagent-complete", outcome: "ok", error: undefined },
      "canonical ended hook",
    );
  });

  it("deletes delete-mode completion runs when announce cleanup gives up after retry limit", async () => {
    mocks.runSubagentAnnounceFlow.mockResolvedValue(false);
    const endedAt = Date.parse("2026-03-24T12:00:00Z");
    mocks.callGateway.mockResolvedValueOnce({
      status: "ok",
      startedAt: endedAt - 500,
      endedAt,
    });

    mod.registerSubagentRun({
      runId: "run-delete-give-up",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(3);
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-delete-give-up"),
    ).toBeUndefined();
  });

  it("finalizes retry-budgeted completion delete runs during resume", async () => {
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-delete", {
        runId: "run-resume-delete",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
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
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    await waitForFast(() => {
      expect(mocks.runSubagentEnded).toHaveBeenCalledTimes(1);
    });
    await waitForFast(() => {
      expect(mocks.onSubagentEnded).toHaveBeenCalledWith({
        childSessionKey: "agent:main:subagent:child",
        reason: "deleted",
        workspaceDir: undefined,
      });
    });
    expect(
      mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-resume-delete"),
    ).toBeUndefined();
  });

  it("suspends retry-budgeted successful keep-mode completion deliveries during resume", async () => {
    mocks.restoreSubagentRunsFromDisk.mockImplementation(((params: {
      runs: Map<string, unknown>;
      mergeOnly?: boolean;
    }) => {
      params.runs.set("run-resume-keep", {
        runId: "run-resume-keep",
        childSessionKey: "agent:main:subagent:child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "resume keep retry budget",
        cleanup: "keep",
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
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey: "agent:main:subagent:child",
            childRunId: "run-resume-keep",
            task: "resume keep retry budget",
            endedAt: Date.parse("2026-03-24T11:59:30Z"),
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
            frozenResultText: "child completed successfully",
          },
        },
      });
      return 1;
    }) as never);

    mod.initSubagentRegistry();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-resume-keep");
    expect(run).toMatchObject({
      delivery: {
        status: "suspended",
        suspendedReason: "retry-limit",
      },
      cleanupHandled: false,
    });
    expect(run?.cleanupCompletedAt).toBeUndefined();
    expect(run?.delivery?.payload).toMatchObject({
      childRunId: "run-resume-keep",
      frozenResultText: "child completed successfully",
    });
  });

  it("clears suspended final delivery fields when reactivating a subagent run", () => {
    const endedAt = Date.parse("2026-03-24T11:59:30Z");
    mod.addSubagentRunForTests({
      runId: "run-suspended-old",
      childSessionKey: "agent:main:subagent:reactivated",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "reactivate suspended delivery",
      cleanup: "keep",
      expectsCompletionMessage: true,
      createdAt: endedAt - 30_000,
      startedAt: endedAt - 20_000,
      endedAt,
      endedReason: "subagent-error",
      outcome: { status: "error", error: "restart interrupted run" },
      terminalOwner: "interrupted-recovery",
      delivery: {
        status: "suspended",
        createdAt: endedAt + 1_000,
        lastAttemptAt: endedAt + 2_000,
        attemptCount: 3,
        lastError: "gateway request timeout for agent",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:reactivated",
          childRunId: "run-suspended-old",
          task: "reactivate suspended delivery",
          endedAt,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "child completed successfully",
        },
        suspendedAt: endedAt + 3_000,
        suspendedReason: "retry-limit",
      },
    });

    expect(
      mod.replaceSubagentRunAfterSteer({
        previousRunId: "run-suspended-old",
        nextRunId: "run-suspended-new",
      }),
    ).toBe(true);

    const replacement = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-suspended-new");
    expect(replacement).toMatchObject({
      runId: "run-suspended-new",
      cleanup: "keep",
      cleanupHandled: false,
    });
    expect(replacement?.endedAt).toBeUndefined();
    expect(replacement?.terminalOwner).toBeUndefined();
    expect(replacement?.delivery?.lastError).toBeUndefined();
    expect(replacement?.delivery?.payload).toBeUndefined();
    expect(replacement?.delivery?.suspendedAt).toBeUndefined();
    expect(replacement?.delivery?.suspendedReason).toBeUndefined();
  });

  it("finalizes expired delete-mode parents when descendant cleanup retriggers deferred announce handling", async () => {
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
      runId: "run-parent-expired",
      childSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles",
      cleanup: "keep",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "yielded parent waiting on descendants",
      cleanup: "keep",
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
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "parent",
      task: "descendant settles after yield",
      cleanup: "keep",
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    const endedHookRunner = {
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    };
    mocks.getGlobalHookRunner.mockReturnValue(null);
    mocks.ensureRuntimePluginsLoaded.mockImplementation(() => {
      mocks.getGlobalHookRunner.mockReturnValue(endedHookRunner as never);
    });

    mod.registerSubagentRun({
      runId: "run-killed-init",
      childSessionKey: "agent:main:subagent:killed",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-1" },
      task: "kill after init",
      cleanup: "keep",
      expectsCompletionMessage: false,
      workspaceDir: "/tmp/killed-workspace",
    });

    const updated = mod.markSubagentRunTerminated({
      runId: "run-killed-init",
      reason: "manual kill",
    });

    expect(updated).toBe(1);
    const killedRun = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-killed-init");
    const killedAt = Date.parse("2026-03-24T12:00:00Z");
    expect(killedRun?.outcome).toEqual({
      status: "error",
      error: "manual kill",
      startedAt: killedAt,
      endedAt: killedAt,
      elapsedMs: 0,
    });
    expect(mocks.runSubagentEnded).not.toHaveBeenCalled();
    mocks.ensureRuntimePluginsLoaded.mockClear();

    vi.setSystemTime(killedAt + 5 * 60_000);
    await mod.testing.sweepOnceForTests();
    await waitForFast(() => {
      expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
        config: {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        },
        workspaceDir: "/tmp/killed-workspace",
        allowGatewaySubagentBinding: true,
      });
    });
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
      outcome: { status: "error", error: "manual kill" },
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish before registry reconciliation persists",
      cleanup: "keep",
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stop without reinjecting",
      cleanup: "keep",
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
    mocks.callGateway.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent.wait") {
        return { status: "pending" };
      }
      return {};
    });
    mocks.getGlobalHookRunner.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded: mocks.runSubagentEnded,
    } as never);
    mod.registerSubagentRun({
      runId: "run-killed-hook-race",
      childSessionKey: "agent:main:subagent:killed-hook-race",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finish while kill hook is publishing",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const lifecycleHandler = mocks.onAgentEvent.mock.calls.at(-1)?.[0] as
      | ((evt: { runId: string; stream: string; data: Record<string, unknown> }) => void)
      | undefined;
    expect(lifecycleHandler).toBeTypeOf("function");

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
      const run = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((entry) => entry.runId === "run-killed-hook-race");
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
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
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
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "quietchat", accountId: "acct-interrupted" },
      requesterDisplayKey: "main",
      task: "recover interrupted subagent",
      cleanup: "keep",
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
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-interrupted");
    expect(run?.outcome).toEqual({
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
    expect(run?.outcome?.error).toContain("Automatic recovery failed after 2 attempts");
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledTimes(announceCalls);
  });

  it("returns zero without mutating the run or task when recovery persistence fails", async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    try {
      const runId = "run-interrupted-persist-failure";
      const childSessionKey = "agent:main:subagent:interrupted-persist-failure";
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        runId,
        task: "preserve interrupted task",
        deliveryStatus: "pending",
        startedAt: 1,
        lastEventAt: 1,
      });
      const entry = {
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve interrupted task",
        cleanup: "keep" as const,
        createdAt: 1,
        startedAt: 1,
      };
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
    endedAt: 2,
    outcome: completeTerminalOutcome,
    endedReason: SUBAGENT_ENDED_REASON_ERROR,
    execution: {
      status: "terminal" as const,
      startedAt: 1,
      endedAt: 2,
      outcome: completeTerminalOutcome,
    },
  };
  it.each([
    ["missing-ended-at", 0, { ...completeTerminalEvidence, endedAt: undefined }, undefined],
    ["missing-outcome", 0, { ...completeTerminalEvidence, outcome: undefined }, undefined],
    ["missing-ended-reason", 0, { ...completeTerminalEvidence, endedReason: undefined }, undefined],
    ["missing-execution", 0, { ...completeTerminalEvidence, execution: undefined }, undefined],
    ["cleanup-complete", 1, completeTerminalEvidence, 2],
    ["cleanup-partial", 0, { ...completeTerminalEvidence, execution: undefined }, 2],
  ])(
    "%s terminal evidence returns %i",
    async (scenario, expected, evidence, cleanupCompletedAt) => {
      const runId = `run-interrupted-${scenario}`;
      const entry = {
        runId,
        childSessionKey: `agent:main:subagent:interrupted-${scenario}`,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "preserve existing terminal evidence",
        cleanup: "keep" as const,
        createdAt: 1,
        startedAt: 1,
        cleanupCompletedAt,
        ...evidence,
      };
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
      requesterSessionKey: "agent:main:main",
      requesterOrigin: undefined,
      requesterDisplayKey: "main",
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

  it("loads plugin and context-engine runtime before released end hooks", async () => {
    mod.addSubagentRunForTests({
      runId: "run-release-context-engine",
      childSessionKey: "agent:main:session:child",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "task",
      cleanup: "keep",
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
    expect(mocks.ensureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        session: { mainKey: "main", scope: "per-sender" },
      },
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
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
    mod.addSubagentRunForTests({
      runId: "run-session-swept-context-engine",
      childSessionKey: "agent:alt:session:child-session",
      controllerSessionKey: "agent:main:session:parent",
      requesterSessionKey: "agent:main:session:parent",
      requesterOrigin: undefined,
      requesterDisplayKey: "parent",
      task: "session cleanup",
      cleanup: "keep",
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

  it("expires suspended cron final deliveries into compact tombstones", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    const runId = "run-suspended-cron-expired";
    mod.addSubagentRunForTests({
      runId,
      childSessionKey: "agent:main:subagent:suspended-cron",
      controllerSessionKey: "agent:main:cron:cron-1:run:parent",
      requesterSessionKey: "agent:main:cron:cron-1:run:parent",
      requesterDisplayKey: "cron",
      task: "cron suspended delivery",
      cleanup: "keep",
      expectsCompletionMessage: true,
      spawnMode: "session",
      createdAt: now - 3 * 60 * 60_000,
      startedAt: now - 3 * 60 * 60_000,
      endedAt: now - 3 * 60 * 60_000,
      outcome: { status: "ok" },
      delivery: {
        status: "suspended",
        createdAt: now - 3 * 60 * 60_000,
        lastAttemptAt: now - 2 * 60 * 60_000 - 1,
        attemptCount: 3,
        lastError: "gateway request timeout for agent",
        payload: {
          requesterSessionKey: "agent:main:cron:cron-1:run:parent",
          requesterDisplayKey: "cron",
          childSessionKey: "agent:main:subagent:suspended-cron",
          childRunId: runId,
          task: "cron suspended delivery",
          endedAt: now - 3 * 60 * 60_000,
          outcome: { status: "ok" },
          expectsCompletionMessage: true,
          frozenResultText: "large final payload",
        },
        suspendedAt: now - 2 * 60 * 60_000 - 1,
        suspendedReason: "retry-limit",
      },
    });

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
      endedAt: now - 3 * 60 * 60_000,
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

  it("pressure-prunes oldest suspended final deliveries when backlog exceeds hard cap", async () => {
    const now = Date.parse("2026-03-24T12:00:00Z");
    for (let i = 0; i < 51; i += 1) {
      const runId = `run-suspended-pressure-${i}`;
      mod.addSubagentRunForTests({
        runId,
        childSessionKey: `agent:main:subagent:suspended-pressure-${i}`,
        controllerSessionKey: "agent:main:main",
        requesterSessionKey: "agent:main:telegram:direct:418181497",
        requesterDisplayKey: "telegram",
        task: "interactive suspended delivery",
        cleanup: "keep",
        expectsCompletionMessage: true,
        spawnMode: "session",
        createdAt: now - 60_000,
        startedAt: now - 60_000,
        endedAt: now - 60_000,
        outcome: { status: "ok" },
        delivery: {
          status: "suspended",
          createdAt: now - 60_000,
          lastAttemptAt: now - 60_000 + i,
          attemptCount: 3,
          lastError: "gateway request timeout for agent",
          payload: {
            requesterSessionKey: "agent:main:telegram:direct:418181497",
            requesterDisplayKey: "telegram",
            childSessionKey: `agent:main:subagent:suspended-pressure-${i}`,
            childRunId: runId,
            task: "interactive suspended delivery",
            endedAt: now - 60_000,
            outcome: { status: "ok" },
            expectsCompletionMessage: true,
            frozenResultText: "final payload",
          },
          suspendedAt: now - 60_000 + i,
          suspendedReason: "retry-limit",
        },
      });
    }

    await mod.testing.sweepOnceForTests();

    const runs = Array.from({ length: 51 }, (_, i) =>
      mod.getSubagentRunByChildSessionKey(`agent:main:subagent:suspended-pressure-${i}`),
    );
    const discarded = runs.filter((run) => run?.delivery?.discardReason === "pressure-pruned");
    const stillSuspended = runs.filter(
      (run) =>
        run?.delivery?.status === "suspended" && typeof run.delivery.suspendedAt === "number",
    );
    expect(discarded).toHaveLength(41);
    expect(stillSuspended).toHaveLength(10);
    expect(discarded[0]?.runId).toBe("run-suspended-pressure-0");
    expect(runs[40]?.delivery?.discardReason).toBe("pressure-pruned");
    expect(runs[41]?.delivery?.status).toBe("suspended");
    expect(mocks.persistSubagentRunsToDisk).toHaveBeenCalled();
  });

  it("contains background sweeper failures while direct sweeps stay observable", async () => {
    mod.registerSubagentRun({
      runId: "run-sweep-error",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sweep error",
      cleanup: "delete",
    });
    const run = mod.getSubagentRunByChildSessionKey("agent:main:subagent:child");
    expect(run).toBeDefined();
    run!.startedAt = Date.now() - 2_000;
    mocks.loadSessionStore.mockImplementation(() => {
      throw new Error("simulated sweep failure");
    });

    await expect(mod.testing.sweepOnceForTests()).rejects.toThrow("simulated sweep failure");
    await expect(mod.testing.runSweeperTickForTests()).resolves.toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
