// Subagent registry archive tests cover keep/delete cleanup modes, retryable
// session deletion, and context-engine lifecycle callbacks.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway } from "../gateway/call.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { getDetachedTaskLifecycleRuntime } from "../tasks/detached-task-runtime.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "../tasks/task-runtime.test-helpers.js";

const taskRuntimeMocks = vi.hoisted(() => ({
  finalizeTaskRunByRunId: vi.fn<(_params: unknown) => unknown[]>(() => [{}]),
}));
const taskStatusMocks = vi.hoisted(() => ({
  findTaskByRunIdForStatus: vi.fn(),
  listTasksForSessionKeyForStatus: vi.fn(() => [] as never[]),
}));

const noop = () => {};
let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.fn(() => currentConfig);
const flushSweepMicrotasks = async () => {
  // Archive sweeps schedule follow-up work through microtasks; drain them before
  // asserting registry and context-engine side effects.
  await Promise.resolve();
  await Promise.resolve();
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "agent.wait") {
      // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
      return { status: "pending" };
    }
    return {};
  }),
}));

vi.mock("../tasks/detached-task-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tasks/detached-task-runtime.js")>();
  return {
    ...actual,
    finalizeTaskRunByRunId: taskRuntimeMocks.finalizeTaskRunByRunId,
  };
});

vi.mock("../tasks/task-status-access.js", () => ({
  findTaskByRunIdForStatus: taskStatusMocks.findTaskByRunIdForStatus,
  listTasksForSessionKeyForStatus: taskStatusMocks.listTasksForSessionKeyForStatus,
}));

vi.mock("../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  getAgentRunContext: vi.fn(() => undefined),
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: vi.fn((_handler: unknown) => noop),
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
  };
});

vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

describe("subagent registry archive behavior", () => {
  let mod: typeof import("./subagent-registry.test-helpers.js");

  beforeAll(async () => {
    mod = await import("./subagent-registry.test-helpers.js");
  });

  const setRegistryTestDeps = (
    overrides: NonNullable<Parameters<typeof mod.testing.setDepsForTest>[0]> = {},
  ) => {
    mod.testing.setDepsForTest({
      callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      ensureRuntimePluginsLoaded: vi.fn(),
      ...overrides,
    });
  };

  const waitForNoRequesterRuns = async () => {
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  };

  beforeEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
    };
    vi.mocked(callGateway).mockReset();
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        // Keep lifecycle unsettled so register/replace assertions can inspect stored state.
        return { status: "pending" };
      }
      return {};
    });
    loadConfigMock.mockClear();
    taskRuntimeMocks.finalizeTaskRunByRunId.mockClear();
    taskStatusMocks.findTaskByRunIdForStatus.mockReset();
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReset();
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([]);
    taskStatusMocks.findTaskByRunIdForStatus.mockImplementation((runId: string) => {
      const entry = mod
        .listSubagentRunsForRequester("agent:main:main")
        .find((candidate) => candidate.runId === runId);
      return entry
        ? ({
            taskId: `task-${runId}`,
            runId,
            runtime: "subagent",
            childSessionKey: entry.childSessionKey,
            createdAt: entry.createdAt,
            status: "cancelled",
            error: SUBAGENT_KILL_TASK_ERROR,
          } as never)
        : undefined;
    });
    setRegistryTestDeps();
    mod.resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetDetachedTaskLifecycleRuntimeForTests();
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
  });

  it("does not set archiveAtMs for keep-mode run subagents", () => {
    mod.registerSubagentRun({
      runId: "run-keep-1",
      childSessionKey: "agent:main:subagent:keep-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-keep-1");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("sets archiveAtMs and sweeps delete-mode run subagents", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-1",
      childSessionKey: "agent:main:subagent:delete-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    const initialRun = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(initialRun?.archiveAtMs).toBe(Date.now() + 60_000);

    await vi.advanceTimersByTimeAsync(60_000);

    await waitForNoRequesterRuns();
  });

  it("keeps archived delete-mode runs for retry when sessions.delete fails", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    const onSubagentEnded = vi.fn(async () => undefined);
    const attachmentsRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sweep-retry-"));
    const attachmentsDir = path.join(attachmentsRootDir, "child");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
    let deleteAttempts = 0;
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("delete failed");
        }
      }
      return {};
    });
    setRegistryTestDeps({
      ensureContextEnginesInitialized: vi.fn(),
      ensureRuntimePluginsLoaded: vi.fn(),
      resolveContextEngine: vi.fn(async () => ({ onSubagentEnded }) as never),
    });

    mod.addSubagentRunForTests({
      runId: "run-delete-retry",
      childSessionKey: "agent:main:subagent:delete-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
      attachmentsDir,
      attachmentsRootDir,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(deleteAttempts).toBe(1);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    expect(onSubagentEnded).not.toHaveBeenCalled();
    await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(deleteAttempts).toBe(2);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
  });

  it("stabilizes provisional killed tasks before deleting expired tombstones", async () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-killed-tombstone-expired",
      childSessionKey: "agent:main:subagent:killed-tombstone-expired",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      startedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "run-killed-tombstone-expired",
      runtime: "subagent",
      sessionKey: "agent:main:subagent:killed-tombstone-expired",
      status: "cancelled",
      endedAt: now - 5 * 60_000,
      lastEventAt: now - 5 * 60_000,
      error: "manual kill",
      suppressDelivery: true,
    });
    await waitForNoRequesterRuns();
  });

  it("retains expired tombstones when provisional task finalization is rejected", async () => {
    const now = Date.now();
    taskRuntimeMocks.finalizeTaskRunByRunId.mockReturnValueOnce([]);
    mod.addSubagentRunForTests({
      runId: "run-killed-tombstone-retry",
      childSessionKey: "agent:main:subagent:killed-tombstone-retry",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retry killed tombstone",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it("retires expired tombstones when their task row is already gone", async () => {
    const now = Date.now();
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue(undefined);
    mod.addSubagentRunForTests({
      runId: "run-killed-task-missing",
      childSessionKey: "agent:main:subagent:killed-task-missing",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retire missing task tombstone",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    await waitForNoRequesterRuns();
  });

  it("preserves stable operator cancellation when retiring expired tombstones", async () => {
    const now = Date.now();
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue({
      taskId: "task-killed-operator-cancelled",
      runId: "run-killed-operator-cancelled",
      runtime: "subagent",
      childSessionKey: "agent:main:subagent:killed-operator-cancelled",
      createdAt: now - 10 * 60_000,
      status: "cancelled",
      error: "Cancelled by operator.",
    } as never);
    mod.addSubagentRunForTests({
      runId: "run-killed-operator-cancelled",
      childSessionKey: "agent:main:subagent:killed-operator-cancelled",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve operator cancellation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    await waitForNoRequesterRuns();
  });

  it("keeps stable cancellation tombstones through the completion grace window", async () => {
    const now = Date.now();
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue({
      taskId: "task-killed-grace",
      runId: "run-killed-grace",
      runtime: "subagent",
      childSessionKey: "agent:main:subagent:killed-grace",
      createdAt: now - 2 * 60_000,
      status: "cancelled",
      error: "Cancelled by operator.",
    } as never);
    mod.addSubagentRunForTests({
      runId: "run-killed-grace",
      childSessionKey: "agent:main:subagent:killed-grace",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "retain cancellation evidence",
      cleanup: "keep",
      createdAt: now - 2 * 60_000,
      endedAt: now - 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();

    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);
    expect(taskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("retires expired tombstones after an opaque legacy runtime finalizer misses", async () => {
    const legacyRuntime = { ...getDetachedTaskLifecycleRuntime() };
    delete legacyRuntime.findTaskRun;
    setDetachedTaskLifecycleRuntime(legacyRuntime);
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue(undefined);
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([]);
    taskRuntimeMocks.finalizeTaskRunByRunId.mockReturnValueOnce([]);
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-killed-opaque-runtime",
      childSessionKey: "agent:main:subagent:killed-opaque-runtime",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "bound opaque runtime reconciliation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalled();
    await waitForNoRequesterRuns();
  });

  it("stabilizes replacement runs through their durable task session scope", async () => {
    const now = Date.now();
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue(undefined);
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([
      {
        taskId: "task-before-replacement",
        runId: "run-before-replacement",
        runtime: "subagent",
        childSessionKey: "agent:main:subagent:replacement",
        status: "running",
        createdAt: now - 11 * 60_000,
      },
    ] as never);
    mod.addSubagentRunForTests({
      runId: "run-after-replacement",
      childSessionKey: "agent:main:subagent:replacement",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stabilize replacement task",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 11 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-before-replacement",
        sessionKey: "agent:main:subagent:replacement",
      }),
    );
    await waitForNoRequesterRuns();
  });

  it("directly kills a replacement run through its durable task ID", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:replacement-direct-kill";
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue(undefined);
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([
      {
        taskId: "task-before-replacement-direct-kill",
        runId: "run-before-replacement-direct-kill",
        runtime: "subagent",
        childSessionKey,
        status: "running",
        createdAt: now - 11 * 60_000,
      },
    ] as never);
    mod.addSubagentRunForTests({
      runId: "run-after-replacement-direct-kill",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "kill replacement task",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 11 * 60_000,
    });

    expect(
      mod.markSubagentRunTerminated({
        runId: "run-after-replacement-direct-kill",
        reason: "manual kill",
      }),
    ).toBe(1);

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-before-replacement-direct-kill",
        sessionKey: childSessionKey,
        status: "cancelled",
      }),
    );
  });

  it("does not reconcile an older tombstone through a newer session task", async () => {
    const now = Date.now();
    taskStatusMocks.findTaskByRunIdForStatus.mockReturnValue(undefined);
    taskStatusMocks.listTasksForSessionKeyForStatus.mockReturnValue([
      {
        taskId: "task-new-generation",
        runId: "run-new-generation",
        runtime: "subagent",
        childSessionKey: "agent:main:subagent:reused-session",
        status: "running",
        createdAt: now - 60_000,
      },
    ] as never);
    mod.addSubagentRunForTests({
      runId: "run-old-generation",
      childSessionKey: "agent:main:subagent:reused-session",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "expire old generation",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      sessionStartedAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: {
        killedAt: now - 5 * 60_000,
        supersededAt: now - 60_000,
      },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    await waitForNoRequesterRuns();
  });

  it("retires expired keep-mode reconciliation rows without deleting their sessions", async () => {
    const now = Date.now();
    mod.addSubagentRunForTests({
      runId: "run-killed-keep-expired",
      childSessionKey: "agent:main:subagent:killed-keep-expired",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stabilize retained session kill",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs: now,
    });

    await mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalled();
    await waitForNoRequesterRuns();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it("stabilizes killed tasks before their configured session archive deadline", async () => {
    const now = Date.now();
    const archiveAtMs = now + 55 * 60_000;
    mod.addSubagentRunForTests({
      runId: "run-killed-retained-session",
      childSessionKey: "agent:main:subagent:killed-retained-session",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stabilize before archive",
      cleanup: "delete",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
      archiveAtMs,
    });

    await mod.testing.sweepOnceForTests();

    expect(taskRuntimeMocks.finalizeTaskRunByRunId).toHaveBeenCalled();
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toEqual([
      expect.objectContaining({
        runId: "run-killed-retained-session",
        archiveAtMs,
        suppressAnnounceReason: undefined,
      }),
    ]);
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.some(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toBe(false);
  });

  it("continues killed cleanup when ended hook loading fails", async () => {
    const now = Date.now();
    setRegistryTestDeps({
      ensureRuntimePluginsLoaded: vi.fn(() => {
        throw new Error("plugin load failed");
      }),
    });
    mod.addSubagentRunForTests({
      runId: "run-killed-hook-load-failure",
      childSessionKey: "agent:main:subagent:killed-hook-load-failure",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "cleanup despite hook failure",
      cleanup: "keep",
      createdAt: now - 10 * 60_000,
      endedAt: now - 5 * 60_000,
      endedReason: "subagent-killed",
      outcome: { status: "error", error: "manual kill" },
      suppressAnnounceReason: "killed",
      killReconciliation: { killedAt: now - 5 * 60_000 },
      cleanupHandled: true,
      cleanupCompletedAt: now - 5 * 60_000,
    });

    await expect(mod.testing.sweepOnceForTests()).resolves.toBeUndefined();
    await flushSweepMicrotasks();

    await waitForNoRequesterRuns();
  });

  it("does not overlap archive sweep retries while sessions.delete is still in flight", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };
    let resolveDelete: (() => void) | undefined;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    vi.mocked(callGateway).mockImplementation(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "sessions.delete") {
        await deletePromise;
      }
      return {};
    });

    mod.addSubagentRunForTests({
      runId: "run-delete-inflight",
      childSessionKey: "agent:main:subagent:delete-inflight",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "inflight delete",
      cleanup: "delete",
      createdAt: Date.now() - 60_000,
      endedAt: Date.now() - 1,
      archiveAtMs: Date.now(),
    });

    const firstSweep = mod.testing.sweepOnceForTests();
    await flushSweepMicrotasks();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(1);

    await mod.testing.sweepOnceForTests();
    expect(
      vi
        .mocked(callGateway)
        .mock.calls.filter(
          ([request]) => (request as { method?: string } | undefined)?.method === "sessions.delete",
        ),
    ).toHaveLength(1);
    expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(1);

    if (!resolveDelete) {
      throw new Error("expected delete resolver");
    }
    resolveDelete();
    await firstSweep;
    await flushSweepMicrotasks();
    await vi.waitFor(() => {
      expect(mod.listSubagentRunsForRequester("agent:main:main")).toHaveLength(0);
    });
  });

  it("does not set archiveAtMs for persistent session-mode runs", () => {
    mod.registerSubagentRun({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:session-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-session",
      cleanup: "keep",
      spawnMode: "session",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.runId).toBe("run-session-1");
    expect(run?.spawnMode).toBe("session");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("keeps archiveAtMs unset when replacing a keep-mode run after steer restart", () => {
    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:run-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent-run",
      cleanup: "keep",
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-new");
    expect(run?.spawnMode).toBe("run");
    expect(run?.archiveAtMs).toBeUndefined();
  });

  it("recomputes archiveAtMs when replacing a delete-mode run after steer restart", async () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 1 } } },
    };

    mod.registerSubagentRun({
      runId: "run-delete-old",
      childSessionKey: "agent:main:subagent:delete-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ephemeral-run",
      cleanup: "delete",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-delete-old",
      nextRunId: "run-delete-new",
    });

    expect(replaced).toBe(true);
    const run = mod
      .listSubagentRunsForRequester("agent:main:main")
      .find((entry) => entry.runId === "run-delete-new");
    expect(run?.archiveAtMs).toBe(Date.now() + 60_000);
  });

  it("removes attachments for the replaced run after steer restart", async () => {
    const attachmentsRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-replace-attachments-"),
    );
    const attachmentsDir = path.join(attachmentsRootDir, "old");
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");

    mod.registerSubagentRun({
      runId: "run-delete-attachments-old",
      childSessionKey: "agent:main:subagent:delete-attachments-old",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "replace attachments",
      cleanup: "delete",
      attachmentsRootDir,
      attachmentsDir,
    });

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-delete-attachments-old",
      nextRunId: "run-delete-attachments-new",
    });

    expect(replaced).toBe(true);
    await vi.waitFor(async () => {
      let err: unknown;
      try {
        await fs.access(attachmentsDir);
      } catch (caught) {
        err = caught;
      }
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    });
  });

  it("treats archiveAfterMinutes=0 as never archive", () => {
    currentConfig = {
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    };

    mod.registerSubagentRun({
      runId: "run-no-archive",
      childSessionKey: "agent:main:subagent:no-archive",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "never archive",
      cleanup: "delete",
    });

    const run = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(run?.archiveAtMs).toBeUndefined();
  });
});
