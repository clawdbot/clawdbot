// Regresses task registry maintenance behavior for issue 60299.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ParsedAgentSessionKey } from "../routing/session-key.js";
import { getDetachedTaskLifecycleRuntime } from "./detached-task-runtime.js";
import {
  CRON_HISTORY_KEEP_PER_JOB,
  getInspectableActiveTaskRestartBlockers,
  getTaskRegistryMaintenanceDiagnostics,
  previewTaskRegistryMaintenance,
  reconcileInspectableTasks,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  setTaskRegistryMaintenanceRuntimeForTests,
  stopTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import type { TaskRecord } from "./task-registry.types.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  setDetachedTaskLifecycleRuntime,
} from "./task-runtime.test-helpers.js";

const GRACE_EXPIRED_MS = 10 * 60_000;

function makeStaleTask(overrides: Partial<TaskRecord>): TaskRecord {
  const now = Date.now();
  return {
    taskId: "task-test-" + Math.random().toString(36).slice(2),
    runtime: "cron",
    requesterSessionKey: "agent:main:main",
    ownerKey: "system:cron:test",
    scopeKind: "system",
    task: "test task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - GRACE_EXPIRED_MS,
    startedAt: now - GRACE_EXPIRED_MS,
    lastEventAt: now - GRACE_EXPIRED_MS,
    ...overrides,
  };
}

type TaskRegistryMaintenanceRuntime = Parameters<
  typeof setTaskRegistryMaintenanceRuntimeForTests
>[0];

afterEach(() => {
  stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  resetDetachedTaskLifecycleRuntimeForTests();
});

function createTaskRegistryMaintenanceHarness(params: {
  tasks: TaskRecord[];
  sessionStore?: Record<string, SessionEntry>;
  listSessionEntries?: TaskRegistryMaintenanceRuntime["listSessionEntries"];
  resolveStorePath?: TaskRegistryMaintenanceRuntime["resolveStorePath"];
  deriveSessionChatTypeFromKey?: TaskRegistryMaintenanceRuntime["deriveSessionChatTypeFromKey"];
  acpEntry?: AcpSessionStoreEntry["entry"];
  activeCronJobIds?: string[];
  activeRunIds?: string[];
  activeAcpSessionKeys?: string[];
  durableCronTaskRows?: Record<string, TaskRecord[]>;
  runtimeAuthoritative?: boolean;
}) {
  const sessionStore = params.sessionStore ?? {};
  const acpEntry = params.acpEntry;
  const activeCronJobIds = new Set(params.activeCronJobIds ?? []);
  const activeRunIds = new Set(params.activeRunIds ?? []);
  const activeAcpSessionKeys = new Set(params.activeAcpSessionKeys ?? []);
  const durableCronTaskRows = params.durableCronTaskRows ?? {};
  const currentTasks = new Map(params.tasks.map((task) => [task.taskId, { ...task }]));

  const runtime: TaskRegistryMaintenanceRuntime = {
    listAcpSessionEntries: async () => [],
    readAcpSessionEntry: () =>
      acpEntry !== undefined
        ? ({
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: acpEntry,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry)
        : ({
            cfg: {} as never,
            storePath: "",
            sessionKey: "",
            storeSessionKey: "",
            entry: undefined,
            storeReadFailed: false,
          } satisfies AcpSessionStoreEntry),
    listSessionEntries:
      params.listSessionEntries ??
      (() =>
        Object.entries(sessionStore).map(([sessionKey, entry]) => ({
          sessionKey,
          entry,
        }))),
    resolveStorePath: params.resolveStorePath ?? (() => ""),
    ...(params.deriveSessionChatTypeFromKey
      ? { deriveSessionChatTypeFromKey: params.deriveSessionChatTypeFromKey }
      : {}),
    isCronJobActive: (jobId: string) => activeCronJobIds.has(jobId),
    getAgentRunContext: (runId: string) =>
      activeRunIds.has(runId) ? { sessionKey: "main" } : undefined,
    hasActiveAcpTurn: (sessionKey: string) => activeAcpSessionKeys.has(sessionKey),
    parseAgentSessionKey: (sessionKey: string | null | undefined): ParsedAgentSessionKey | null => {
      if (!sessionKey) {
        return null;
      }
      const [kind, agentId, ...rest] = sessionKey.split(":");
      return kind === "agent" && agentId && rest.length > 0
        ? { agentId, rest: rest.join(":") }
        : null;
    },
    hasActiveTaskForChildSessionKey: ({ sessionKey, excludeTaskId }) => {
      const normalized = sessionKey.trim().toLowerCase();
      return Array.from(currentTasks.values()).some(
        (task) =>
          task.taskId !== excludeTaskId &&
          (task.status === "queued" || task.status === "running") &&
          task.childSessionKey?.trim().toLowerCase() === normalized,
      );
    },
    deleteTaskRecordById: (taskId: string) => currentTasks.delete(taskId),
    ensureTaskRegistryReady: () => {},
    getTaskById: (taskId: string) => currentTasks.get(taskId),
    listTaskRecords: () => Array.from(currentTasks.values()),
    markTaskLostById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: "lost" as const,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.cleanupAfter !== undefined ? { cleanupAfter: patch.cleanupAfter } : {}),
      };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    markTaskTerminalById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = {
        ...current,
        status: patch.status,
        endedAt: patch.endedAt,
        lastEventAt: patch.lastEventAt ?? patch.endedAt,
        ...(patch.terminalSummary !== undefined
          ? {
              terminalSummary: patch.preserveTerminalSummary
                ? (patch.terminalSummary ?? undefined)
                : patch.terminalSummary?.replace(/\s+/g, " ").trim() || undefined,
            }
          : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      } satisfies TaskRecord;
      if (Object.hasOwn(patch, "error")) {
        if (patch.error === undefined) {
          delete next.error;
        } else {
          next.error = patch.error;
        }
      }
      currentTasks.set(patch.taskId, next);
      return next;
    },
    maybeDeliverTaskTerminalUpdate: async () => null,
    resolveTaskForLookupToken: () => undefined,
    setTaskCleanupAfterById: (patch) => {
      const current = currentTasks.get(patch.taskId);
      if (!current) {
        return null;
      }
      const next = { ...current, cleanupAfter: patch.cleanupAfter };
      currentTasks.set(patch.taskId, next);
      return next;
    },
    isRuntimeAuthoritative: () => params.runtimeAuthoritative ?? true,
    listTaskRegistryRecordsByRuntimeSourceIdFromSqlite: ({ sourceId }) =>
      sourceId ? (durableCronTaskRows[sourceId] ?? []) : Object.values(durableCronTaskRows).flat(),
  };

  setTaskRegistryMaintenanceRuntimeForTests(runtime);
  return { currentTasks };
}

function expectMaintenanceCounts(
  result: Awaited<ReturnType<typeof runTaskRegistryMaintenance>>,
  expected: { reconciled: number; recovered?: number },
): void {
  expect(result.reconciled).toBe(expected.reconciled);
  if (expected.recovered !== undefined) {
    expect(result.recovered).toBe(expected.recovered);
  }
}

function requireTaskRecord(tasks: Map<string, TaskRecord>, taskId: string): TaskRecord {
  const task = tasks.get(taskId);
  if (!task) {
    throw new Error(`Expected task ${taskId}`);
  }
  return task;
}

function expectTaskStatus(
  tasks: Map<string, TaskRecord>,
  taskId: string,
  status: TaskRecord["status"],
): void {
  expect(requireTaskRecord(tasks, taskId).status).toBe(status);
}

describe("task-registry maintenance issue #60299", () => {
  it("reuses session entry lists across stale subagent task checks in one pass", async () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeStaleTask({
        runtime: "subagent",
        taskId: `task-subagent-stale-${index}`,
        childSessionKey: `agent:main:subagent:stale-${index}`,
      }),
    );
    const listSessionEntriesMock = vi.fn(() => []);

    createTaskRegistryMaintenanceHarness({
      tasks,
      listSessionEntries: listSessionEntriesMock,
      resolveStorePath: () => "/tmp/openclaw-test-sessions-main.json",
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: tasks.length });
    expect(listSessionEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("reuses CLI channel session type derivation across duplicate stale task checks", async () => {
    const childSessionKey = "agent:main:discord:direct:user-1";
    const tasks = Array.from({ length: 10 }, (_, index) =>
      makeStaleTask({
        runtime: "cli",
        taskId: `task-cli-channel-stale-${index}`,
        childSessionKey,
      }),
    );
    const deriveSessionChatTypeMock = vi.fn(() => "direct" as const);

    createTaskRegistryMaintenanceHarness({
      tasks,
      deriveSessionChatTypeFromKey: deriveSessionChatTypeMock,
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: tasks.length });
    expect(deriveSessionChatTypeMock).toHaveBeenCalledTimes(1);
  });

  it("marks stale cron tasks lost once the runtime no longer tracks the job as active", async () => {
    const childSessionKey = "agent:main:workspace:channel:test-channel";
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-1",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [childSessionKey]: { sessionId: childSessionKey, updatedAt: Date.now() } },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
  });

  it("keeps active cron tasks live while the cron runtime still owns the job", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-2",
      childSessionKey: undefined,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      activeCronJobIds: ["cron-job-2"],
      durableCronTaskRows: {
        "cron-job-2": [
          {
            ...task,
            status: "succeeded",
            endedAt: Date.now(),
            detail: { kind: "cron-run", status: "ok" },
          },
        ],
      },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
  });

  it("reclaims a stale running ACP task with no live turn even though its session-store entry survives", async () => {
    const childSessionKey = "agent:claude:acp:crashed-zombie";
    const task = makeStaleTask({
      runtime: "acp",
      runId: "run-acp-crashed-zombie",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      acpEntry: { sessionId: childSessionKey, updatedAt: Date.now() },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
    expect(getInspectableActiveTaskRestartBlockers()).toHaveLength(0);
  });

  it("keeps a running ACP task live while a prompt turn is still in flight", async () => {
    const childSessionKey = "agent:claude:acp:in-flight-turn";
    const task = makeStaleTask({
      runtime: "acp",
      runId: "run-acp-in-flight",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      acpEntry: { sessionId: childSessionKey, updatedAt: Date.now() },
      activeAcpSessionKeys: [childSessionKey],
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
    expect(getInspectableActiveTaskRestartBlockers()).toHaveLength(1);
  });

  it("does not reclaim a running ACP task from a non-authoritative process even with an empty live-turn map", async () => {
    const childSessionKey = "agent:claude:acp:gateway-owned-live-turn";
    const staleAt = Date.now() - 40 * 60_000;
    const task = makeStaleTask({
      runtime: "acp",
      runId: "run-acp-gateway-owned",
      childSessionKey,
      createdAt: staleAt,
      startedAt: staleAt,
      lastEventAt: staleAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      acpEntry: { sessionId: childSessionKey, updatedAt: Date.now() },
      activeAcpSessionKeys: [],
      runtimeAuthoritative: false,
    });

    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 0 });
    expect(getTaskRegistryMaintenanceDiagnostics().staleRunningTasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        decision: "retained",
        reason: "acp_runtime_not_authoritative",
      }),
    );
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
    expect(getInspectableActiveTaskRestartBlockers()).toHaveLength(1);
  });

  it("only treats started non-ended running tasks as restart blockers", () => {
    const now = Date.now();
    const activeRunning = makeStaleTask({
      taskId: "task-running-live",
      runtime: "cli",
      status: "running",
      createdAt: now,
      startedAt: now,
      lastEventAt: now,
      runId: "run-running-live",
    });
    const queued = makeStaleTask({
      taskId: "task-queued-durable",
      runtime: "acp",
      status: "queued",
      createdAt: now,
      startedAt: undefined,
      lastEventAt: now,
    });
    const staleInconsistent = makeStaleTask({
      taskId: "task-running-ended",
      runtime: "subagent",
      status: "running",
      endedAt: now - 1_000,
    });

    createTaskRegistryMaintenanceHarness({ tasks: [activeRunning, queued, staleInconsistent] });

    const blockers = getInspectableActiveTaskRestartBlockers();
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.taskId).toBe("task-running-live");
    expect(blockers[0]?.status).toBe("running");
    expect(blockers[0]?.runtime).toBe("cli");
    expect(blockers[0]?.runId).toBe("run-running-live");
  });

  it("marks subagent tasks lost when their child session recovery is tombstoned", async () => {
    const childSessionKey = "agent:main:subagent:wedged-child";
    const staleAt = Date.now() - 45 * 60_000;
    const task = makeStaleTask({
      runtime: "subagent",
      runId: "run-wedged-child",
      childSessionKey,
      createdAt: staleAt,
      startedAt: staleAt,
      lastEventAt: staleAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: {
        [childSessionKey]: {
          sessionId: "session-wedged-child",
          updatedAt: Date.now(),
          abortedLastRun: false,
          subagentRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: Date.now() - 30_000,
            lastRunId: "run-wedged-child",
            wedgedAt: Date.now() - 20_000,
            wedgedReason: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
          },
        },
      },
    });

    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 1 });
    expect(getTaskRegistryMaintenanceDiagnostics().staleRunningTasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        decision: "would_reconcile",
        reason: "subagent_recovery_wedged",
        detail: "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
      }),
    );
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1 });
    const storedTask = requireTaskRecord(currentTasks, task.taskId);
    expect(storedTask.status).toBe("lost");
    expect(storedTask.error).toBe(
      "subagent orphan recovery blocked after 2 rapid accepted resume attempts",
    );
  });

  it("does not mark cron tasks lost when the current process is not the cron runtime authority", async () => {
    const staleAt = Date.now() - 40 * 60_000;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-offline-audit",
      childSessionKey: undefined,
      createdAt: staleAt,
      startedAt: staleAt,
      lastEventAt: staleAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      runtimeAuthoritative: false,
    });

    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 0 });
    expect(getTaskRegistryMaintenanceDiagnostics().staleRunningTasks).toContainEqual(
      expect.objectContaining({
        taskId: task.taskId,
        decision: "retained",
        reason: "cron_runtime_not_authoritative",
      }),
    );
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
  });

  it("recovers finished cron tasks from durable ledger detail before marking them lost", async () => {
    const startedAt = Date.now() - 60 * 60_000;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-run-log-ok",
      runId: `cron:cron-job-run-log-ok:${startedAt}`,
      startedAt,
      lastEventAt: startedAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-run-log-ok": [
          {
            ...task,
            status: "succeeded",
            endedAt: startedAt + 1250,
            lastEventAt: startedAt + 1250,
            terminalSummary: "done",
            detail: { kind: "cron-run", status: "ok", durationMs: 1250 },
          },
        ],
      },
    });

    const reconciledTasks = reconcileInspectableTasks();
    expect(reconciledTasks).toHaveLength(1);
    expect(reconciledTasks[0]?.taskId).toBe(task.taskId);
    expect(reconciledTasks[0]?.status).toBe("succeeded");
    expect(reconciledTasks[0]?.endedAt).toBe(startedAt + 1250);
    expect(reconciledTasks[0]?.terminalSummary).toBe("done");
    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 0, recovered: 1 });
    expect(getTaskRegistryMaintenanceDiagnostics().staleRunningTasks).toHaveLength(0);
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0, recovered: 1 });
    const storedTask = requireTaskRecord(currentTasks, task.taskId);
    expect(storedTask.status).toBe("succeeded");
    expect(storedTask.endedAt).toBe(startedAt + 1250);
    expect(storedTask.terminalSummary).toBe("done");
    expect(storedTask.detail).toEqual({ kind: "cron-run", status: "ok", durationMs: 1250 });
  });

  it("recovers cancelled cron tasks with exact durable summaries", async () => {
    const startedAt = Date.now() - 60 * 60_000;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-cancelled",
      runId: `cron:cron-job-cancelled:${startedAt}`,
      startedAt,
      lastEventAt: startedAt,
    });
    const terminalSummary = "cancelled\n  summary";

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-cancelled": [
          {
            ...task,
            status: "cancelled",
            error: "cancelled by operator",
            endedAt: startedAt + 500,
            lastEventAt: startedAt + 500,
            terminalSummary,
            detail: { kind: "cron-run", status: "error", durationMs: 500 },
          },
        ],
      },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0, recovered: 1 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "cancelled",
      endedAt: startedAt + 500,
      terminalSummary,
      detail: { kind: "cron-run", status: "error", durationMs: 500 },
    });
  });

  it("does not recover cron tasks from an unrelated ledger row", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-run-log-ok",
      runId: "cron:cron-job-run-log-ok:1e3",
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-run-log-ok": [
          {
            ...task,
            taskId: "different-task",
            runId: "cron:cron-job-run-log-ok:1000",
            status: "succeeded",
            endedAt: 1250,
            lastEventAt: 1250,
            terminalSummary: "done",
            detail: { kind: "cron-run", status: "ok" },
          },
        ],
      },
    });

    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 1, recovered: 0 });
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1, recovered: 0 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
  });

  it("recovers terminal lost cron tasks from the durable ledger", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-terminal-lost-ok",
      runId: `cron:cron-job-terminal-lost-ok:${startedAt}`,
      status: "lost",
      error: "backing session missing",
      startedAt,
      endedAt: startedAt + 60_000,
      lastEventAt: startedAt + 60_000,
      cleanupAfter: Date.now() + 60_000,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-terminal-lost-ok": [
          {
            ...task,
            status: "succeeded",
            error: undefined,
            endedAt: startedAt + 1250,
            lastEventAt: startedAt + 1250,
            terminalSummary: "done",
            detail: { kind: "cron-run", status: "ok" },
          },
        ],
      },
    });

    const reconciled = reconcileInspectableTasks();
    expect(reconciled).toEqual([
      expect.objectContaining({
        taskId: task.taskId,
        status: "succeeded",
        endedAt: startedAt + 1250,
        terminalSummary: "done",
      }),
    ]);
    expect(reconciled[0]).not.toHaveProperty("error");
    expect(previewTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ reconciled: 0, recovered: 1 });
    const recoveredTask = currentTasks.get(task.taskId);
    expect(recoveredTask).toMatchObject({
      status: "succeeded",
      endedAt: startedAt + 1250,
      terminalSummary: "done",
    });
    expect(recoveredTask).not.toHaveProperty("error");
  });

  it("does not recover terminal lost cron tasks without a backing-session error", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-terminal-lost-no-error",
      runId: `cron:cron-job-terminal-lost-no-error:${startedAt}`,
      status: "lost",
      startedAt,
      endedAt: startedAt + 60_000,
      lastEventAt: startedAt + 60_000,
      cleanupAfter: Date.now() + 60_000,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-terminal-lost-no-error": [
          {
            ...task,
            status: "succeeded",
            endedAt: startedAt + 1250,
            lastEventAt: startedAt + 1250,
            terminalSummary: "done",
            detail: { kind: "cron-run", status: "ok" },
          },
        ],
      },
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ recovered: 0 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ recovered: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "lost",
    });
  });

  it("does not recover terminal lost cron tasks with non-backing-session errors", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-terminal-lost-other-error",
      runId: `cron:cron-job-terminal-lost-other-error:${startedAt}`,
      status: "lost",
      error: "operator marked lost",
      startedAt,
      endedAt: startedAt + 60_000,
      lastEventAt: startedAt + 60_000,
      cleanupAfter: Date.now() + 60_000,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      durableCronTaskRows: {
        "cron-job-terminal-lost-other-error": [
          {
            ...task,
            status: "succeeded",
            error: undefined,
            endedAt: startedAt + 1250,
            lastEventAt: startedAt + 1250,
            terminalSummary: "done",
            detail: { kind: "cron-run", status: "ok" },
          },
        ],
      },
    });

    expect(previewTaskRegistryMaintenance()).toMatchObject({ recovered: 0 });
    expect(await runTaskRegistryMaintenance()).toMatchObject({ recovered: 0 });
    expect(currentTasks.get(task.taskId)).toMatchObject({
      status: "lost",
      error: "operator marked lost",
    });
  });

  it("does not recover cron tasks from cron job state without a terminal ledger row", async () => {
    const startedAt = Date.now() - GRACE_EXPIRED_MS;
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-state-error",
      runId: `cron:cron-job-state-error:${startedAt}`,
      startedAt,
      lastEventAt: startedAt,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({ tasks: [task] });

    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 1, recovered: 0 });
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1, recovered: 0 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
  });

  it("marks chat-backed cli tasks lost after the owning run context disappears", async () => {
    const channelKey = "agent:main:workspace:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-stale",
      runId: "run-chat-cli-stale",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
  });

  it("does not keep stale CLI run-context tasks alive through stale subagent session rows", async () => {
    const childSessionKey = "agent:main:subagent:stale-cli";
    const task = makeStaleTask({
      taskId: "task-cli-stale-subagent",
      runtime: "cli",
      sourceId: "run-cli-stale-subagent",
      runId: "run-cli-stale-subagent",
      childSessionKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [childSessionKey]: { sessionId: childSessionKey, updatedAt: Date.now() } },
    });

    const reconciledTasks = reconcileInspectableTasks();
    expect(reconciledTasks).toHaveLength(1);
    expect(reconciledTasks[0]?.taskId).toBe(task.taskId);
    expect(reconciledTasks[0]?.status).toBe("lost");
    expect(reconciledTasks[0]?.error).toBe("backing session missing");
    expect(getInspectableActiveTaskRestartBlockers()).toStrictEqual([]);
    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 1 });
    expectTaskStatus(currentTasks, task.taskId, "lost");
  });

  it("keeps chat-backed cli tasks live while the owning run context is still active", async () => {
    const channelKey = "agent:main:workspace:channel:C1234567890";
    const task = makeStaleTask({
      runtime: "cli",
      sourceId: "run-chat-cli-live",
      runId: "run-chat-cli-live",
      ownerKey: "agent:main:main",
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
      activeRunIds: ["run-chat-cli-live"],
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
  });

  it("keeps detached media cli tasks live while their tool run context is active", async () => {
    const channelKey = "agent:main:discord:channel:1456744319972282449";
    const runId = "tool:video_generate:ac88dfc5-c2a9-4630-ab48-384e6450a12b";
    const task = makeStaleTask({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      runId,
      ownerKey: channelKey,
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
      progressSummary: "Generating video",
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
      activeRunIds: [runId],
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
  });

  it("keeps recently refreshed media cli tasks live without a chat run context", async () => {
    const channelKey = "agent:main:discord:channel:1456744319972282449";
    const task = makeStaleTask({
      runtime: "cli",
      taskKind: "video_generation",
      sourceId: "video_generate:fal",
      runId: "tool:video_generate:3a948fb2-79e8-470c-a6bc-46f37732cd3d",
      ownerKey: channelKey,
      requesterSessionKey: channelKey,
      childSessionKey: channelKey,
      lastEventAt: Date.now() - 60_000,
      progressSummary: "Generating video",
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
      sessionStore: { [channelKey]: { sessionId: channelKey, updatedAt: Date.now() } },
    });

    expectMaintenanceCounts(await runTaskRegistryMaintenance(), { reconciled: 0 });
    expectTaskStatus(currentTasks, task.taskId, "running");
  });

  it("skips markTaskLost and counts recovered when recovery hook recovers a stale task", async () => {
    const task = makeStaleTask({
      runtime: "cron",
      sourceId: "cron-job-recovered",
      childSessionKey: undefined,
    });

    const { currentTasks } = createTaskRegistryMaintenanceHarness({
      tasks: [task],
    });

    const recoveryHook = vi.fn(() => ({ recovered: true }));
    setDetachedTaskLifecycleRuntime({
      ...getDetachedTaskLifecycleRuntime(),
      tryRecoverTaskBeforeMarkLost: recoveryHook,
    });

    const beforeMaintenance = Date.now();
    expectMaintenanceCounts(previewTaskRegistryMaintenance(), { reconciled: 1, recovered: 0 });
    const result = await runTaskRegistryMaintenance();
    expectMaintenanceCounts(result, { reconciled: 0, recovered: 1 });
    expectTaskStatus(currentTasks, task.taskId, "running");
    const hookCalls = recoveryHook.mock.calls as unknown as Array<
      [params: { now?: unknown; runtime?: unknown; task?: { taskId?: string }; taskId?: string }]
    >;
    expect(hookCalls).toHaveLength(1);
    const hookParams = hookCalls[0]?.[0];
    expect(hookParams?.taskId).toBe(task.taskId);
    expect(hookParams?.runtime).toBe("cron");
    expect(hookParams?.task?.taskId).toBe(task.taskId);
    const hookNow = hookParams?.now;
    expect(typeof hookNow).toBe("number");
    if (typeof hookNow !== "number") {
      throw new Error("Expected task recovery hook now timestamp");
    }
    expect(hookNow).toBeGreaterThanOrEqual(beforeMaintenance);
  });

  it("keeps the newest 2000 terminal cron rows per source", async () => {
    const now = Date.now();
    const tasks = Array.from({ length: CRON_HISTORY_KEEP_PER_JOB + 1 }, (_, index) =>
      makeStaleTask({
        taskId: `cron-history-${index}`,
        runtime: "cron",
        sourceId: "cron-history-job",
        status: "succeeded",
        endedAt: now + index + 1,
        lastEventAt: now + index + 1,
        cleanupAfter: 0,
      }),
    );
    const lostTask = makeStaleTask({
      taskId: "cron-history-lost",
      runtime: "cron",
      sourceId: "cron-history-job",
      status: "lost",
      endedAt: now - 60 * 60_000,
      lastEventAt: now - 60 * 60_000,
      cleanupAfter: undefined,
    });
    tasks.push(lostTask);
    const { currentTasks } = createTaskRegistryMaintenanceHarness({ tasks });

    const result = await runTaskRegistryMaintenance();

    expect(result.pruned).toBe(1);
    expect(currentTasks.size).toBe(CRON_HISTORY_KEEP_PER_JOB + 1);
    expect(currentTasks.has("cron-history-0")).toBe(false);
    expect(currentTasks.has("cron-history-1")).toBe(true);
    expect(currentTasks.has(lostTask.taskId)).toBe(true);
  });

  it("still stamps non-cron terminal rows with default retention", async () => {
    const endedAt = Date.now();
    const task = makeStaleTask({
      runtime: "subagent",
      status: "succeeded",
      endedAt,
      lastEventAt: endedAt,
      cleanupAfter: undefined,
    });
    const { currentTasks } = createTaskRegistryMaintenanceHarness({ tasks: [task] });

    const result = await runTaskRegistryMaintenance();

    expect(result.cleanupStamped).toBe(1);
    expect(requireTaskRecord(currentTasks, task.taskId).cleanupAfter).toBe(
      endedAt + 7 * 24 * 60 * 60_000,
    );
  });

  it("still prunes lost cron rows after 24 hours", async () => {
    const endedAt = Date.now() - 25 * 60 * 60_000;
    const task = makeStaleTask({
      sourceId: "lost-cron-job",
      status: "lost",
      endedAt,
      lastEventAt: endedAt,
      cleanupAfter: undefined,
    });
    const { currentTasks } = createTaskRegistryMaintenanceHarness({ tasks: [task] });

    const result = await runTaskRegistryMaintenance();

    expect(result.pruned).toBe(1);
    expect(currentTasks.has(task.taskId)).toBe(false);
  });
});
