// Covers task registry store persistence, in-memory behavior, and observer notifications.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { bindExecutionOwnerLifecycleMetadata } from "../audit/execution-owner-lifecycle-binding-store.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  collectCronHistoryOverflowTaskIds,
  CRON_HISTORY_KEEP_PER_JOB,
} from "./cron-history-retention.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskRegistryMaintenanceSnapshot } from "./task-registry-maintenance-snapshot.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskById,
  listFreshTasksForOwnerKey,
  listTaskRecords,
  markTaskTerminalById,
  reloadTaskRegistryFromStore,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  getInspectableActiveTaskRestartBlockers,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
} from "./task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import {
  bindTaskRecord,
  bindTaskRunExecution,
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryStateFromSqliteReadOnly,
  loadTaskRegistryStateFromSqliteReadOnlyResult,
  deleteTaskAndDeliveryStateFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskDeliveryState, TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";
import {
  parseOptionalTaskTerminalOutcome,
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
} from "./task-registry.types.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";
import { listTasksForOwnerOrRequesterSessionKeyForStatus } from "./task-status-access.js";

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

it("normalizes missing terminal timestamps at the SQLite write boundary", () => {
  const bound = bindTaskRecord({
    taskId: "task-legacy-terminal",
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: "Legacy terminal",
    status: "failed",
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 250,
  });

  expect(bound.ended_at).toBe(250);
});

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}
type TaskRegistryTestDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_delivery_state" | "task_runs"
>;

function requireFirstUpsertParams(upsertTaskWithDeliveryState: ReturnType<typeof vi.fn>): {
  task?: { taskId?: string };
  deliveryState?: { lastNotifiedEventAt?: number };
} {
  const [call] = upsertTaskWithDeliveryState.mock.calls;
  if (!call) {
    throw new Error("expected task upsert params");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected task upsert params to be an object");
  }
  return params;
}

function createStoredTask(): TaskRecord {
  return {
    taskId: "task-restored",
    runtime: "acp",
    sourceId: "run-restored",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: "agent:codex:acp:restored",
    runId: "run-restored",
    task: "Restored task",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 100,
    lastEventAt: 100,
  };
}

function createUnsafeTaskOwnerIndex(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX idx_task_runs_owner_key;
    CREATE INDEX idx_task_runs_owner_key ON task_runs(status);
  `);
  database.enableDefensive?.(false);
  database.exec("PRAGMA writable_schema = ON;");
  database
    .prepare(
      "UPDATE sqlite_schema SET sql = 'CREATE INDEX idx_task_runs_owner_key ON task_runs(owner_key)' WHERE name = 'idx_task_runs_owner_key'",
    )
    .run();
  const schemaVersion = readSqliteNumberPragma(database, "schema_version");
  database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
}

describe("task-registry store runtime", () => {
  it("does not create shared state for a read-only task snapshot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-readonly-" },
      async () => {
        const statePath = resolveOpenClawStateSqlitePath();
        expect(() => statSync(statePath)).toThrow();

        const snapshot = loadTaskRegistryStateFromSqliteReadOnly();
        expect(snapshot.tasks.size).toBe(0);
        expect(snapshot.deliveryStates.size).toBe(0);
        expect(() => statSync(statePath)).toThrow();
      },
    );
  });

  it("reports an additive schema migration without querying newer task columns", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-old-schema-" },
      async () => {
        const database = openOpenClawStateDatabase();
        database.db.exec("ALTER TABLE task_runs DROP COLUMN tool_use_count");
        closeOpenClawStateDatabase();

        expect(loadTaskRegistryStateFromSqliteReadOnlyResult()).toEqual({
          state: "migration-required",
          snapshot: {
            tasks: new Map(),
            deliveryStates: new Map(),
          },
        });
      },
    );
  });
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-task-store-suite-",
    });
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  afterEach(() => {
    testState.applyEnv();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    resetTaskRegistryMaintenanceRuntimeForTests();
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("uses the configured task store for restore and writes", () => {
    const storedTask = createStoredTask();
    const store = createInMemoryTaskRegistryStore({
      tasks: new Map([[storedTask.taskId, storedTask]]),
      deliveryStates: new Map(),
    });
    const loadSnapshot = vi.fn(store.loadSnapshot);
    const upsertTaskWithDeliveryState = vi.fn(store.upsertTaskWithDeliveryState);
    configureTaskRegistryRuntime({
      store: { ...store, loadSnapshot, upsertTaskWithDeliveryState },
    });

    expect(findTaskByRunId("run-restored")).toMatchObject({
      taskId: "task-restored",
      task: "Restored task",
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(upsertTaskWithDeliveryState).toHaveBeenCalledOnce();
    const latestSnapshot = store.loadSnapshot();
    expect(latestSnapshot.tasks.size).toBe(2);
    expect(latestSnapshot.tasks.get("task-restored")?.task).toBe("Restored task");
  });

  it("logs restore parser failures and keeps the failure sticky", async () => {
    const warnLogs = createWarnLogCapture("openclaw-task-registry-restore-test");
    const invalidValue = "not-requested";
    const loadSnapshot = vi.fn(() => {
      throw new Error(`Invalid persisted task delivery status: ${JSON.stringify(invalidValue)}`);
    });
    try {
      configureTaskRegistryRuntime({
        store: {
          ...createInMemoryTaskRegistryStore(),
          loadSnapshot,
        },
      });

      expect(() => findTaskByRunId("run-restored")).toThrow(
        `Task registry restore failed: Invalid persisted task delivery status: "${invalidValue}"`,
      );
      expect(await warnLogs.findText(invalidValue)).toContain(invalidValue);
      expect(() => getTaskById("task-restored")).toThrow(
        `Task registry restore failed: Invalid persisted task delivery status: "${invalidValue}"`,
      );
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      warnLogs.cleanup();
    }
  });

  it("includes restore parser failures in compact console warnings", () => {
    const warn = vi.fn();
    const invalidValue = "future-invalid-status";
    setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => {
          throw new Error(
            `Invalid persisted task delivery status: ${JSON.stringify(invalidValue)}`,
          );
        },
      },
    });

    expect(() => findTaskByRunId("run-restored")).toThrow(
      `Task registry restore failed: Invalid persisted task delivery status: "${invalidValue}"`,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `Failed to restore task registry: Invalid persisted task delivery status: "${invalidValue}"`,
    );
  });

  it("blocks writes until an explicit reload recovers the registry", () => {
    const storedTask = createStoredTask();
    let restoreShouldFail = true;
    const loadSnapshot = vi.fn(() => {
      if (restoreShouldFail) {
        throw new Error("SQLITE_CORRUPT: malformed task registry");
      }
      return {
        tasks: new Map([[storedTask.taskId, storedTask]]),
        deliveryStates: new Map(),
      };
    });
    const upsertTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot,
        upsertTaskWithDeliveryState,
      },
    });

    expect(() =>
      createTaskRecord({
        runtime: "cron",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "Must not overwrite hidden durable tasks",
        status: "queued",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
      }),
    ).toThrow("Task registry restore failed: SQLITE_CORRUPT: malformed task registry");
    expect(() => getTaskById(storedTask.taskId)).toThrow(
      "Task registry restore failed: SQLITE_CORRUPT: malformed task registry",
    );
    expect(upsertTaskWithDeliveryState).not.toHaveBeenCalled();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    restoreShouldFail = false;
    reloadTaskRegistryFromStore();

    expect(getTaskById(storedTask.taskId)).toMatchObject({ taskId: storedTask.taskId });
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("clears a sticky restore failure during the test reset boundary", () => {
    const failedLoad = vi.fn(() => {
      throw new Error("SQLITE_IOERR: failed to read task registry");
    });
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: failedLoad,
      },
    });

    expect(() => getTaskById("task-restored")).toThrow(
      "Task registry restore failed: SQLITE_IOERR: failed to read task registry",
    );
    resetTaskRegistryForTests({ persist: false });

    const cleanLoad = vi.fn(() => ({
      tasks: new Map<string, TaskRecord>(),
      deliveryStates: new Map<string, TaskDeliveryState>(),
    }));
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: cleanLoad,
      },
    });

    expect(getTaskById("task-restored")).toBeUndefined();
    expect(failedLoad).toHaveBeenCalledTimes(1);
    expect(cleanLoad).toHaveBeenCalledTimes(1);
  });

  it("uses scoped owner lookups for fresh owner task reads", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map(),
      deliveryStates: new Map(),
    }));
    const listTasksForOwnerKey = vi.fn(() => [storedTask]);
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot,
        listTasksForOwnerKey,
      },
    });

    const tasks = listFreshTasksForOwnerKey("agent:main:main");

    expect(tasks.map((task) => task.taskId)).toEqual(["task-restored"]);
    expect(listTasksForOwnerKey).toHaveBeenCalledWith("agent:main:main");
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not clone non-blocker details when inspecting restart blockers", () => {
    const now = Date.now();
    const active: TaskRecord = {
      ...createStoredTask(),
      runtime: "cli",
      createdAt: now,
      lastEventAt: now,
      detail: ["active detail"],
    };
    const nonBlockerDetail = { history: "not needed for restart inspection" };
    const storedTasks: TaskRecord[] = [
      { ...active, taskId: "older", createdAt: now - 1_000 },
      { ...active, taskId: "tie-first" },
      ...(["queued", "succeeded", "failed", "timed_out", "cancelled", "lost"] as const).map(
        (status) => Object.assign({}, active, { taskId: status, status, detail: nonBlockerDetail }),
      ),
      { ...active, taskId: "running-ended", endedAt: now, detail: nonBlockerDetail },
      { ...active, taskId: "tie-last" },
    ];
    const writeStore = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(storedTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState: writeStore,
        deleteTaskWithDeliveryState: writeStore,
        upsertDeliveryState: writeStore,
      },
    });
    // Restore before measuring: the hot query, not startup hydration, owns this assertion.
    expect(getTaskById("older")?.taskId).toBe("older");
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const blockers = getInspectableActiveTaskRestartBlockers();
      expect(blockers.map((task) => task.taskId)).toEqual(["tie-last", "tie-first", "older"]);
      expect(clone).not.toHaveBeenCalledWith(nonBlockerDetail);
      blockers[0]!.title = "caller mutation";
      expect(getInspectableActiveTaskRestartBlockers()[0]?.title).toBe(active.task);
      expect(writeStore).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }

    const allTasks = listTaskRecords();
    expect(allTasks).toHaveLength(storedTasks.length);
    expect(allTasks[0]?.taskId).toBe("tie-last");
    const returnedDetail = allTasks[0]?.detail;
    expect(returnedDetail).toEqual(["active detail"]);
    if (!Array.isArray(returnedDetail)) {
      throw new Error("expected array task detail");
    }
    returnedDetail.push("caller mutation");
    expect(listTaskRecords()[0]?.detail).toEqual(["active detail"]);
  });

  it("selects session status tasks before cloning unrelated details", () => {
    const sessionKey = "agent:main:cron:job:run:run-id";
    const unrelatedDetail = { history: "unrelated task output" };
    const base: TaskRecord = {
      ...createStoredTask(),
      requesterSessionKey: "other-requester",
      ownerKey: "other-owner",
      detail: [["selected detail"]],
    };
    const storedTasks: TaskRecord[] = [
      { ...base, taskId: "older", ownerKey: sessionKey, createdAt: 50 },
      { ...base, taskId: "owner-only", ownerKey: sessionKey },
      { ...base, taskId: "unrelated", createdAt: 500, detail: unrelatedDetail },
      { ...base, taskId: "requester-only", requesterSessionKey: sessionKey },
      { ...base, taskId: "child-only", childSessionKey: sessionKey, detail: unrelatedDetail },
      { ...base, taskId: "padded-owner", ownerKey: ` ${sessionKey} `, detail: unrelatedDetail },
    ];
    const writeStore = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(storedTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState: writeStore,
        deleteTaskWithDeliveryState: writeStore,
        upsertDeliveryState: writeStore,
      },
    });
    expect(getTaskById("owner-only")?.taskId).toBe("owner-only");
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      const selected = listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey);
      expect(selected.map((task) => task.taskId)).toEqual([
        "requester-only",
        "owner-only",
        "older",
      ]);
      expect(clone).not.toHaveBeenCalledWith(unrelatedDetail);
      const detail = selected[0]?.detail;
      if (!Array.isArray(detail) || !Array.isArray(detail[0])) {
        throw new Error("expected nested task detail");
      }
      detail[0].push("caller mutation");
      expect(getTaskById("requester-only")?.detail).toEqual([["selected detail"]]);
      expect(writeStore).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("does not duplicate retained detail clones during maintenance", async () => {
    const now = Date.now();
    const detail = { output: "retained task output" };
    const storedTasks: TaskRecord[] = Array.from({ length: 8 }, (_, index) => ({
      ...createStoredTask(),
      taskId: `retained-${index}`,
      runtime: "cli",
      status: "succeeded",
      createdAt: now,
      lastEventAt: now,
      endedAt: now,
      cleanupAfter: now + 24 * 60 * 60_000,
      detail,
    }));
    const writeStore = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(storedTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState: writeStore,
        deleteTaskWithDeliveryState: writeStore,
        upsertDeliveryState: writeStore,
      },
      observers: null,
    });
    expect(getTaskById("retained-0")?.taskId).toBe("retained-0");
    const clone = vi.spyOn(globalThis, "structuredClone");
    try {
      expect(await runTaskRegistryMaintenance()).toEqual({
        reconciled: 0,
        recovered: 0,
        cleanupStamped: 0,
        pruned: 0,
      });
      expect(clone.mock.calls.filter(([value]) => value === detail).length).toBeLessThanOrEqual(
        storedTasks.length,
      );
      expect(writeStore).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
  });

  it("preserves task order and raw cron partitions in maintenance snapshots", () => {
    const base: TaskRecord = {
      ...createStoredTask(),
      runtime: "cron",
      status: "succeeded",
      endedAt: 100,
    };
    const partitions: { prefix: string; sourceId: string; detail: TaskRecord["detail"] }[] = [
      { prefix: "empty-history", sourceId: "job", detail: { kind: "cron-run", storeKey: "" } },
      { prefix: "empty-quiet", sourceId: "job", detail: { storeKey: "" } },
      { prefix: "space-store", sourceId: "job", detail: { kind: "cron-run", storeKey: " " } },
      { prefix: "missing-store", sourceId: "job", detail: { kind: "cron-run" } },
      { prefix: "padded-job", sourceId: " job ", detail: { kind: "cron-run", storeKey: "" } },
      { prefix: "space-job", sourceId: " ", detail: { kind: "cron-run", storeKey: "" } },
    ];
    const storedTasks: TaskRecord[] = [
      ...partitions.flatMap(({ prefix, sourceId, detail }) =>
        Array.from({ length: CRON_HISTORY_KEEP_PER_JOB + 1 }, (_, index) => ({
          ...base,
          taskId: `${prefix}-${String(index).padStart(4, "0")}`,
          sourceId,
          detail,
        })),
      ),
      ...Array.from(["newer-first", "newer-last"], (taskId) => ({
        ...base,
        taskId,
        runtime: "cli" as const,
        createdAt: 200,
        lastEventAt: 200,
        endedAt: 200,
      })),
      { ...base, taskId: "older", createdAt: 50, lastEventAt: 50, endedAt: 50 },
      { ...base, taskId: "missing-source", sourceId: undefined },
      { ...base, taskId: "empty-source", sourceId: "" },
      ...Array.from(["queued", "running", "lost"] as const, (status) => ({
        ...base,
        taskId: `excluded-${status}`,
        sourceId: "job",
        status,
        createdAt: 300,
        lastEventAt: 300,
        endedAt: status === "lost" ? 300 : undefined,
        detail: { kind: "cron-run", storeKey: "" },
      })),
    ];
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(storedTasks.map((task) => [task.taskId, task])),
          deliveryStates: new Map(),
        }),
      },
      observers: null,
    });
    const listed = listTaskRecords();
    const snapshot = getTaskRegistryMaintenanceSnapshot();
    expect(snapshot.taskIds).toEqual(listed.map((task) => task.taskId));
    expect(snapshot.taskIds.slice(0, 5)).toEqual([
      "excluded-lost",
      "excluded-running",
      "excluded-queued",
      "newer-last",
      "newer-first",
    ]);
    expect(snapshot.taskIds.at(-1)).toBe("older");
    expect([...snapshot.cronHistoryOverflowTaskIds]).toEqual([
      ...collectCronHistoryOverflowTaskIds(listed),
    ]);
    expect(snapshot.cronHistoryOverflowTaskIds).toEqual(
      new Set(partitions.map(({ prefix }) => `${prefix}-0000`)),
    );
  });

  it("rejects invalid persisted task enum values", () => {
    expect(parseTaskRuntime("cron")).toBe("cron");
    expect(parseTaskScopeKind("system")).toBe("system");
    expect(parseTaskStatus("running")).toBe("running");
    expect(parseTaskDeliveryStatus("pending")).toBe("pending");
    expect(parseTaskDeliveryStatus("dismissed")).toBe("dismissed");
    expect(parseTaskNotifyPolicy("done_only")).toBe("done_only");
    expect(parseOptionalTaskTerminalOutcome("blocked")).toBe("blocked");
    expect(parseOptionalTaskTerminalOutcome(null)).toBeUndefined();

    expect(() => parseTaskRuntime("timer")).toThrow("Invalid persisted task runtime");
    expect(() => parseTaskScopeKind("workspace")).toThrow("Invalid persisted task scope kind");
    expect(() => parseTaskStatus("done")).toThrow("Invalid persisted task status");
    expect(() => parseTaskDeliveryStatus("ok")).toThrow("Invalid persisted task delivery status");
    expect(() => parseTaskNotifyPolicy("verbose")).toThrow("Invalid persisted task notify policy");
    expect(() => parseOptionalTaskTerminalOutcome("failed")).toThrow(
      "Invalid persisted task terminal outcome",
    );
  });

  it.each(["verbose", "", "state-change", "DONE_ONLY"])(
    "rejects an invalid notification policy before it can poison a SQLite restart (%s)",
    async (invalidPolicy) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-task-invalid-notify-" },
        async () => {
          resetTaskRegistryForTests({ persist: false });
          const created = createTaskRecord({
            runtime: "acp",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            childSessionKey: "agent:main:acp:notify-policy",
            runId: "run-invalid-notify-policy",
            task: "Keep the task registry readable",
            status: "running",
            deliveryStatus: "pending",
            notifyPolicy: "done_only",
          });
          const database = openOpenClawStateDatabase();
          const db = getNodeSqliteKysely<TaskRegistryTestDatabase>(database.db);

          let mutationError: string | null = null;
          try {
            updateTaskNotifyPolicyById({
              taskId: created.taskId,
              notifyPolicy: invalidPolicy as TaskNotifyPolicy,
            });
          } catch (error) {
            mutationError = error instanceof Error ? error.message : String(error);
          }

          const persisted = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("task_runs")
              .select("notify_policy")
              .where("task_id", "=", created.taskId),
          );

          let restoredPolicy: TaskNotifyPolicy | null = null;
          let restoreError: string | null = null;
          try {
            reloadTaskRegistryFromStore();
            restoredPolicy = getTaskById(created.taskId)?.notifyPolicy ?? null;
          } catch (error) {
            restoreError = error instanceof Error ? error.message : String(error);
          }

          try {
            expect({
              mutationError,
              persistedPolicy: persisted?.notify_policy,
              restoredPolicy,
              restoreError,
            }).toEqual({
              mutationError: `Invalid persisted task notify policy: ${JSON.stringify(invalidPolicy)}`,
              persistedPolicy: "done_only",
              restoredPolicy: "done_only",
              restoreError: null,
            });
          } finally {
            if (persisted?.notify_policy !== "done_only") {
              executeSqliteQuerySync(
                database.db,
                db
                  .updateTable("task_runs")
                  .set({ notify_policy: "done_only" })
                  .where("task_id", "=", created.taskId),
              );
            }
            resetTaskRegistryForTests({ persist: false });
          }
        },
      );
    },
  );

  it.each(["done_only", "state_changes", "silent"] as const)(
    "persists valid notification policy %s across a fresh SQLite restart",
    async (notifyPolicy) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-task-valid-notify-" },
        async () => {
          resetTaskRegistryForTests({ persist: false });
          const created = createTaskRecord({
            runtime: "acp",
            ownerKey: "agent:main:main",
            scopeKind: "session",
            childSessionKey: "agent:main:acp:notify-policy",
            runId: "run-valid-notify-policy",
            task: "Preserve valid notification policies",
            status: "running",
            deliveryStatus: "pending",
            notifyPolicy: "done_only",
          });

          expect(
            updateTaskNotifyPolicyById({ taskId: created.taskId, notifyPolicy })?.notifyPolicy,
          ).toBe(notifyPolicy);
          reloadTaskRegistryFromStore();
          expect(getTaskById(created.taskId)?.notifyPolicy).toBe(notifyPolicy);
        },
      );
    },
  );

  it("rejects corrupt persisted task rows during sqlite restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-corrupt-" },
      async () => {
        resetTaskRegistryForTests({ persist: false });
        const created = createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-corrupt",
          runId: "run-corrupt-task-status",
          task: "Corrupt task row",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<TaskRegistryTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db.updateTable("task_runs").set({ status: "done" }).where("task_id", "=", created.taskId),
        );

        expect(() => loadTaskRegistryStateFromSqlite()).toThrow("Invalid persisted task status");
      },
    );
  });

  it("drops invalid requester origins during sqlite restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-invalid-origin-" },
      async () => {
        resetTaskRegistryForTests({ persist: false });
        const created = createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:acp:origin",
          runId: "run-invalid-origin",
          task: "Invalid origin task",
          status: "running",
          deliveryStatus: "pending",
          requesterOrigin: {
            channel: "test-channel",
            to: "C1234567890",
          },
        });

        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<TaskRegistryTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("task_delivery_state")
            .set({ requester_origin_json: '["bad-origin"]' })
            .where("task_id", "=", created.taskId),
        );

        const restored = loadTaskRegistryStateFromSqlite();
        expect(restored.deliveryStates.get(created.taskId)?.requesterOrigin).toBeUndefined();
      },
    );
  });

  it("round-trips runtime-owned task detail through sqlite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-detail-" },
      async () => {
        const task: TaskRecord = {
          ...createStoredTask(),
          runtime: "cron",
          sourceId: "cron-detail-job",
          detail: {
            kind: "cron-run",
            status: "ok",
            usage: { input_tokens: 3, cached: false },
          },
        };
        upsertTaskWithDeliveryStateToSqlite({ task });

        expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)?.detail).toEqual(
          task.detail,
        );
      },
    );
  });

  it("preserves explicit null task detail through sqlite", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-null-detail-" },
      async () => {
        const task: TaskRecord = {
          ...createStoredTask(),
          detail: null,
        };
        upsertTaskWithDeliveryStateToSqlite({ task });

        const restored = loadTaskRegistryStateFromSqlite().tasks.get(task.taskId);
        expect(restored).toHaveProperty("detail", null);
      },
    );
  });

  it("loads task and delivery rows from one sqlite read snapshot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-read-snapshot-" },
      async () => {
        resetTaskRegistryForTests({ persist: false });
        const created = createTaskRecord({
          runtime: "acp",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:acp:snapshot",
          runId: "run-read-snapshot",
          task: "Read one task registry snapshot",
          status: "running",
          deliveryStatus: "pending",
          requesterOrigin: {
            channel: "test-channel",
            to: "C1234567890",
          },
        });
        const database = openOpenClawStateDatabase();
        database.db
          .prepare("UPDATE task_delivery_state SET last_notified_event_at = ? WHERE task_id = ?")
          .run(100, created.taskId);
        const { DatabaseSync } = requireNodeSqlite();
        const writer = new DatabaseSync(database.path);
        writer.exec("PRAGMA busy_timeout = 1000;");
        const originalPrepare = database.db.prepare.bind(database.db);
        let writerCommitted = false;
        const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql: string) => {
          if (sql.includes('from "task_delivery_state"') && !writerCommitted) {
            writerCommitted = true;
            writer
              .prepare(
                "UPDATE task_delivery_state SET last_notified_event_at = ? WHERE task_id = ?",
              )
              .run(200, created.taskId);
          }
          return originalPrepare(sql);
        });

        try {
          const restored = loadTaskRegistryStateFromSqlite();
          expect(restored.deliveryStates.get(created.taskId)?.lastNotifiedEventAt).toBe(100);
          expect(
            writer
              .prepare("SELECT last_notified_event_at FROM task_delivery_state WHERE task_id = ?")
              .get(created.taskId),
          ).toEqual({ last_notified_event_at: 200 });
        } finally {
          prepareSpy.mockRestore();
          writer.close();
        }
      },
    );
  });

  it("bypasses stale owner indexes for complete fresh results", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-owner-index-" },
      async () => {
        resetTaskRegistryForTests({ persist: false });
        const ownerKey = "agent:main:main";
        const target = createTaskRecord({
          runtime: "cron",
          ownerKey,
          scopeKind: "session",
          sourceId: "owner-index-target",
          runId: "run-owner-index-target",
          task: "Find the target owner task",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:other:main",
          scopeKind: "session",
          sourceId: "owner-index-other",
          runId: "run-owner-index-other",
          task: "Ignore another owner task",
          status: "queued",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });
        expect(listFreshTasksForOwnerKey(ownerKey).map((task) => task.taskId)).toContain(
          target.taskId,
        );

        const database = openOpenClawStateDatabase();
        createUnsafeTaskOwnerIndex(database.db);
        expect(database.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(database.db.prepare("PRAGMA integrity_check('task_runs')").all()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              integrity_check: expect.stringMatching(/idx_task_runs_owner_key/),
            }),
          ]),
        );
        expect(
          database.db
            .prepare(
              "SELECT task_id FROM task_runs INDEXED BY idx_task_runs_owner_key WHERE owner_key = ?",
            )
            .all(ownerKey),
        ).toEqual([]);
        expect(() => loadTaskRegistryStateFromSqlite()).toThrow(
          /integrity_check failed.*idx_task_runs_owner_key/iu,
        );
        expect(listFreshTasksForOwnerKey(ownerKey).map((task) => task.taskId)).toContain(
          target.taskId,
        );

        resetTaskRegistryForTests({ persist: false });
      },
    );
  });

  it("emits incremental observer events for restore, mutation, and delete", () => {
    const events: TaskRegistryObserverEvent[] = [];
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map(),
        }),
      },
      observers: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    expect(findTaskByRunId("run-restored")).toMatchObject({
      runId: "run-restored",
      taskId: "task-restored",
      task: "Restored task",
    });
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-new",
      task: "New task",
      status: "running",
      deliveryStatus: "pending",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(events.map((event) => event.kind)).toEqual(["restored", "upserted", "deleted"]);
    expect(events[0]).toMatchObject({
      kind: "restored",
      tasks: [expect.objectContaining({ taskId: "task-restored" })],
    });
    expect(events[1]).toMatchObject({
      kind: "upserted",
      task: expect.objectContaining({ taskId: created.taskId }),
    });
    expect(events[2]).toMatchObject({
      kind: "deleted",
      taskId: created.taskId,
    });
  });

  it("uses atomic task-plus-delivery store methods", async () => {
    const upsertTaskWithDeliveryState = vi.fn();
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState,
        deleteTaskWithDeliveryState,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-atomic",
      task: "Atomic task",
      status: "running",
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });

    await maybeDeliverTaskStateChangeUpdate(created.taskId, {
      at: 200,
      kind: "progress",
      summary: "working",
    });
    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(upsertTaskWithDeliveryState).toHaveBeenCalled();
    expect(requireFirstUpsertParams(upsertTaskWithDeliveryState)).toMatchObject({
      task: expect.objectContaining({
        taskId: created.taskId,
      }),
    });
    expect(
      upsertTaskWithDeliveryState.mock.calls.some((call) => {
        const params = call[0] as { deliveryState?: { lastNotifiedEventAt?: number } };
        return params.deliveryState?.lastNotifiedEventAt === 200;
      }),
    ).toBe(true);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
  });

  it("restores persisted tasks from the default sqlite store", () => {
    const created = createTaskRecord({
      runtime: "cron",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      sourceId: "job-123",
      runId: "run-sqlite",
      task: "Run nightly cron",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-sqlite")).toMatchObject({
      taskId: created.taskId,
      sourceId: "job-123",
      task: "Run nightly cron",
    });
  });

  it("persists executor and requester agent ids in sqlite task rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-agent-id-" },
      async () => {
        const created = createTaskRecord({
          runtime: "subagent",
          requesterSessionKey: "global",
          ownerKey: "global",
          scopeKind: "session",
          childSessionKey: "agent:worker:subagent:child",
          requesterAgentId: "main",
          runId: "run-worker-subagent-sqlite",
          task: "Inspect worker state",
          status: "running",
          deliveryStatus: "pending",
        });

        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<TaskRegistryTestDatabase>(database.db);
        const row = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("task_runs")
            .select(["agent_id", "requester_agent_id", "child_session_key", "owner_key"])
            .where("task_id", "=", created.taskId),
        );

        expect(row).toEqual({
          agent_id: "worker",
          requester_agent_id: "main",
          child_session_key: "agent:worker:subagent:child",
          owner_key: "global",
        });

        resetTaskRegistryForTests({ persist: false });
        expect(findTaskByRunId("run-worker-subagent-sqlite")).toMatchObject({
          taskId: created.taskId,
          agentId: "worker",
          requesterAgentId: "main",
        });
      },
    );
  });

  it("persists tool activity across sqlite restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-tool-activity-" },
      async () => {
        const created = createTaskRecord({
          runtime: "subagent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:subagent:tools",
          runId: "run-tool-activity-sqlite",
          task: "Sweep files",
          status: "running",
          deliveryStatus: "not_applicable",
        });
        emitAgentEvent({
          runId: "run-tool-activity-sqlite",
          stream: "tool",
          data: { phase: "start", name: "read", toolCallId: "call-1" },
        });

        resetTaskRegistryForTests({ persist: false });
        expect(findTaskByRunId("run-tool-activity-sqlite")).toMatchObject({
          taskId: created.taskId,
          toolUseCount: 1,
          lastToolName: "read",
        });
      },
    );
  });

  it("normalizes a legacy terminal row with no persisted end time", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-legacy-terminal-" },
      async () => {
        const created = createTaskRecord({
          runtime: "cli",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          runId: "run-legacy-terminal-sqlite",
          task: "Legacy terminal row",
          status: "running",
          deliveryStatus: "pending",
        });
        const terminalAt = created.createdAt + 1_000;
        const database = openOpenClawStateDatabase();
        const db = getNodeSqliteKysely<TaskRegistryTestDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("task_runs")
            .set({ status: "failed", ended_at: null, last_event_at: terminalAt })
            .where("task_id", "=", created.taskId),
        );

        expect(loadTaskRegistryStateFromSqlite().tasks.get(created.taskId)?.endedAt).toBe(
          terminalAt,
        );
        expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(created.taskId)?.endedAt).toBe(
          terminalAt,
        );
      },
    );
  });

  it("persists requester origin atomically when creating sqlite tasks", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-create-origin-" },
      async () => {
        const created = createTaskRecord({
          runtime: "acp",
          requesterSessionKey: "agent:main:workspace:channel:C1234567890",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          childSessionKey: "agent:main:workspace:channel:C1234567890",
          runId: "run-create-origin",
          task: "Reply to channel task",
          status: "running",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          requesterOrigin: {
            channel: "test-channel",
            to: "C1234567890",
          },
        });

        resetTaskRegistryForTests({ persist: false });

        expect(findTaskByRunId("run-create-origin")).toMatchObject({
          taskId: created.taskId,
        });
        const deliveryState = loadTaskRegistryStateFromSqlite().deliveryStates.get(created.taskId);
        expect(deliveryState?.requesterOrigin).toEqual({
          channel: "test-channel",
          to: "C1234567890",
        });
      },
    );
  });

  it("persists parentFlowId with task rows", () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/task-store-parent-flow",
      goal: "Persist linked tasks",
    });
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      parentFlowId: flow.flowId,
      childSessionKey: "agent:codex:acp:new",
      runId: "run-flow-linked",
      task: "Linked task",
      status: "running",
      deliveryStatus: "pending",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-flow-linked")).toMatchObject({
      taskId: created.taskId,
      parentFlowId: flow.flowId,
    });
  });

  it("preserves requesterSessionKey when it differs from ownerKey across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "cli",
      requesterSessionKey: "agent:main:workspace:channel:C1234567890",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:main:workspace:channel:C1234567890",
      runId: "run-requester-session-restore",
      task: "Reply to channel task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-requester-session-restore")).toMatchObject({
      taskId: created.taskId,
      requesterSessionKey: "agent:main:workspace:channel:C1234567890",
      ownerKey: "agent:main:main",
      childSessionKey: "agent:main:workspace:channel:C1234567890",
    });
  });

  it("preserves taskKind across sqlite restore", () => {
    const created = createTaskRecord({
      runtime: "acp",
      taskKind: "video_generation",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:video",
      runId: "run-task-kind-restore",
      task: "Render a short clip",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
    });

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("run-task-kind-restore")).toMatchObject({
      taskId: created.taskId,
      taskKind: "video_generation",
      runId: "run-task-kind-restore",
    });
  });

  it("keeps nonpersistent resets storage-free and normal resets metadata-free", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const databasePath = resolveOpenClawStateSqlitePath(process.env);
      expect(existsSync(databasePath)).toBe(false);
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      expect(existsSync(databasePath)).toBe(false);

      resetTaskRegistryForTests();
      resetTaskFlowRegistryForTests();
      expect(
        tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
      ).toBe(false);
    });
  });

  it("clears only the reset family's rows and orphan bindings", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
      const task = createStoredTask();
      upsertTaskWithDeliveryStateToSqlite({ task, deliveryState: { taskId: task.taskId } });
      const flow = createManagedTaskFlow({
        ownerKey: task.ownerKey,
        controllerId: "tests/reset-flow",
        goal: "Retained flow",
      });
      const { db } = openOpenClawStateDatabase();
      for (const [ownerKind, ownerId] of [
        ["task", task.taskId],
        ["task", "orphan-task"],
        ["flow", flow.flowId],
        ["flow", "orphan-flow"],
        ["cron", "retained-cron"],
      ] as const) {
        bindExecutionOwnerLifecycleMetadata({
          db,
          ownerKind,
          ownerId,
          binding: { contextId: "reset-context", executionId: "reset-execution" },
        });
      }
      // Reset must not parse malformed fixture payloads before deleting them.
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<TaskRegistryTestDatabase>(db)
          .updateTable("task_runs")
          .set({ detail_json: "{" }),
      );
      const readBindings = () =>
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT owner_kind, owner_id FROM execution_owner_lifecycle_bindings ORDER BY owner_kind, owner_id",
          )
          .all();

      resetTaskRegistryForTests();
      expect(db.isOpen).toBe(false);
      expect(loadTaskRegistryStateFromSqlite()).toEqual({
        tasks: new Map(),
        deliveryStates: new Map(),
      });
      expect(readBindings()).toEqual([
        { owner_kind: "cron", owner_id: "retained-cron" },
        ...[flow.flowId, "orphan-flow"]
          .toSorted()
          .map((owner_id) => ({ owner_kind: "flow", owner_id })),
      ]);
      upsertTaskWithDeliveryStateToSqlite({ task });
      bindExecutionOwnerLifecycleMetadata({
        db: openOpenClawStateDatabase().db,
        ownerKind: "task",
        ownerId: task.taskId,
        binding: { contextId: "reset-context", executionId: "reset-execution" },
      });
      resetTaskFlowRegistryForTests({ persist: false });
      expect(getTaskFlowById(flow.flowId)).toEqual(flow);

      resetTaskFlowRegistryForTests();
      expect(getTaskFlowById(flow.flowId)).toBeUndefined();
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(task);
      expect(readBindings()).toEqual([
        { owner_kind: "cron", owner_id: "retained-cron" },
        { owner_kind: "task", owner_id: task.taskId },
      ]);
    });
  });

  it("removes omitted delivery state without changing other task rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-delivery-prune-" },
      async () => {
        const taskA = createStoredTask();
        const taskB: TaskRecord = {
          ...createStoredTask(),
          taskId: "task-retained-delivery-b",
          runId: "run-retained-delivery-b",
        };
        const deliveryA: TaskDeliveryState = {
          taskId: taskA.taskId,
          lastNotifiedEventAt: 100,
        };
        const deliveryB: TaskDeliveryState = {
          taskId: taskB.taskId,
          lastNotifiedEventAt: 200,
        };

        upsertTaskWithDeliveryStateToSqlite({ task: taskA, deliveryState: deliveryA });
        upsertTaskWithDeliveryStateToSqlite({ task: taskB, deliveryState: deliveryB });
        upsertTaskWithDeliveryStateToSqlite({ task: taskA });

        const restored = loadTaskRegistryStateFromSqlite();
        expect(restored.tasks).toEqual(
          new Map([
            [taskA.taskId, taskA],
            [taskB.taskId, taskB],
          ]),
        );
        expect(restored.deliveryStates.has(taskA.taskId)).toBe(false);
        expect(restored.deliveryStates.get(taskB.taskId)).toEqual(deliveryB);
      },
    );
  });

  it("binds only live task owners and retains their metadata after terminalization", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-binding-owner-" },
      async () => {
        const active = { ...createStoredTask(), taskId: "task-binding-active" };
        const retained = { ...createStoredTask(), taskId: "task-binding-retained" };
        const terminal: TaskRecord = {
          ...createStoredTask(),
          taskId: "task-binding-terminal",
          status: "succeeded",
          endedAt: 200,
        };
        const stale: TaskRecord = {
          ...createStoredTask(),
          taskId: "task-binding-stale",
          endedAt: 199,
        };
        for (const task of [active, retained, terminal, stale]) {
          upsertTaskWithDeliveryStateToSqlite({ task });
        }
        const admitted: AdmittedRunContext = {
          operationalRunInstance: { instanceId: "instance-task-owner", runId: "run-task-owner" },
          executionIdentityToken: createExecutionIdentityAdmissionToken("run-task-owner", {
            contextId: "context-task-owner",
            executionId: "execution-task-owner",
          }),
        };

        expect(
          tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
        ).toBe(false);
        expect(bindTaskRunExecution({ admitted, taskId: terminal.taskId })).toBe("missing");
        expect(bindTaskRunExecution({ admitted, taskId: stale.taskId })).toBe("missing");
        expect(
          tableExists(openOpenClawStateDatabase().db, "execution_owner_lifecycle_bindings"),
        ).toBe(false);
        expect(bindTaskRunExecution({ admitted, taskId: active.taskId })).toBe("bound");
        expect(bindTaskRunExecution({ admitted, taskId: retained.taskId })).toBe("bound");

        const finished = { ...active, status: "succeeded" as const, endedAt: 210 };
        upsertTaskWithDeliveryStateToSqlite({ task: finished });
        expect(bindTaskRunExecution({ admitted, taskId: finished.taskId })).toBe("missing");
        expect(
          openOpenClawStateDatabase()
            .db.prepare(
              `SELECT owner_id
               FROM execution_owner_lifecycle_bindings
               WHERE owner_kind = 'task' ORDER BY owner_id`,
            )
            .all(),
        ).toEqual([{ owner_id: active.taskId }, { owner_id: retained.taskId }]);

        deleteTaskAndDeliveryStateFromSqlite(active.taskId);
        const restored = loadTaskRegistryStateFromSqlite();
        expect([...restored.tasks.keys()].toSorted()).toEqual(
          [retained.taskId, terminal.taskId, stale.taskId].toSorted(),
        );
        expect(
          openOpenClawStateDatabase()
            .db.prepare(
              "SELECT owner_id FROM execution_owner_lifecycle_bindings WHERE owner_kind = 'task'",
            )
            .all(),
        ).toEqual([{ owner_id: retained.taskId }]);
      },
    );
  });

  it("reopens after the shared state database is closed", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-" },
      async () => {
        const task = createStoredTask();
        upsertTaskWithDeliveryStateToSqlite({ task });

        closeOpenClawStateDatabase();

        const restored = loadTaskRegistryStateFromSqlite();
        expect(restored.tasks.get(task.taskId)).toEqual(task);
      },
    );
  });

  it("hardens the sqlite task store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-" },
      async () => {
        createTaskRecord({
          runtime: "cron",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          sourceId: "job-456",
          runId: "run-perms",
          task: "Run secured cron",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
        });

        const databasePath = resolveOpenClawStateSqlitePath(process.env);
        const registryDir = path.dirname(databasePath);
        expect(databasePath.endsWith(path.join("state", "openclaw.sqlite"))).toBe(true);
        expect(statSync(registryDir).mode & 0o777).toBe(0o700);
        expect(statSync(databasePath).mode & 0o777).toBe(0o600);
      },
    );
  });

  it("does not throw or diverge sqlite-direct reads when an upsert persist fails", () => {
    const ownerKey = "agent:main:main";
    // sqlite holds the source-of-truth row. status=running (current). When the
    // upsert throws, sqlite keeps this value (withWriteTransaction ROLLBACK +
    // re-throw).
    const sqliteRow: TaskRecord = {
      ...createStoredTask(),
      taskId: "task-diverge",
      runId: "run-diverge",
      ownerKey,
      status: "running",
    };
    const sqliteState = new Map<string, TaskRecord>([[sqliteRow.taskId, sqliteRow]]);

    let failUpsert = false;
    const upsertTaskWithDeliveryState = vi.fn((params: { task: TaskRecord }) => {
      if (failUpsert) {
        // Same failure mode as production SQLITE_BUSY/FULL/IOERR ->
        // withWriteTransaction ROLLBACK + re-throw. The sqlite row is untouched.
        throw new Error("SQLITE_FULL: database or disk is full");
      }
      sqliteState.set(params.task.taskId, params.task);
    });
    const deleteTaskWithDeliveryState = vi.fn((taskId: string) => {
      sqliteState.delete(taskId);
    });
    // sqlite-direct reader (listFreshTasksForOwnerKey -> store.listTasksForOwnerKey).
    // Always returns the sqlite source of truth.
    const listTasksForOwnerKey = vi.fn((key: string) =>
      [...sqliteState.values()].filter((task) => task.ownerKey === key),
    );

    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(sqliteState),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState,
        deleteTaskWithDeliveryState,
        listTasksForOwnerKey,
      },
    });

    // in-memory loads the same row via loadSnapshot. Start state: both running.
    const initial = listFreshTasksForOwnerKey(ownerKey);
    expect(initial.find((task) => task.taskId === "task-diverge")?.status).toBe("running");

    // Attempt a transition running -> succeeded. updateTask must persist before
    // committing the in-memory map, so when persist fails the in-memory state is
    // left untouched and the failure does not escape the task-registry API.
    failUpsert = true;
    expect(
      markTaskTerminalById({
        taskId: "task-diverge",
        status: "succeeded",
        endedAt: 200,
      }),
    ).toBeNull();

    // Divergence check: persist failed, so the in-memory mutation must not be
    // committed. The discriminating read is the in-memory path (getTaskById):
    // in the buggy ordering the in-memory record is left at "succeeded" while
    // sqlite still holds "running", so the two stores diverge. With
    // persist-before-in-memory the in-memory record stays "running".
    failUpsert = false;
    expect(getTaskById("task-diverge")?.status).toBe("running");

    // The sqlite-direct reader (used by media-generation-task-status-shared)
    // also keeps "running", so both read paths agree.
    const after = listFreshTasksForOwnerKey(ownerKey);
    const seen = after.find((task) => task.taskId === "task-diverge");
    expect(seen?.status).toBe("running");
  });

  it("does not throw or mutate memory when create persistence fails", () => {
    const upsertTaskWithDeliveryState = vi.fn(
      (_params: { task: TaskRecord; deliveryState?: TaskDeliveryState }) => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    );
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState,
      },
    });

    const created = createTaskRecordOrNull({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:create-fail",
      runId: "run-create-fail",
      task: "Create while persistence fails",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(created).toBeNull();
    const attempted = upsertTaskWithDeliveryState.mock.calls[0]?.[0]?.task;
    expect(attempted?.taskId).toEqual(expect.any(String));
    expect(getTaskById(attempted?.taskId ?? "")).toBeUndefined();
  });

  it("does not report duplicate create metadata updates as applied when persistence fails", () => {
    const first = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:duplicate-create-fail",
      runId: "run-duplicate-create-fail",
      task: "Original task",
      status: "running",
      deliveryStatus: "pending",
    });
    const upsertTaskWithDeliveryState = vi.fn(
      (_params: { task: TaskRecord; deliveryState?: TaskDeliveryState }) => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    );
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map([[first.taskId, first]]),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState,
      },
    });

    const duplicate = createTaskRecordOrNull({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:duplicate-create-fail",
      runId: "run-duplicate-create-fail",
      task: "Updated task",
      status: "running",
      deliveryStatus: "pending",
      preferMetadata: true,
    });

    expect(duplicate).toBeNull();
    expect(getTaskById(first.taskId)?.task).toBe("Original task");
  });

  it("does not throw or delete memory when delete persistence fails", () => {
    const sqliteRow = {
      ...createStoredTask(),
      taskId: "task-delete-persist-fail",
      runId: "run-delete-persist-fail",
    };
    const sqliteState = new Map<string, TaskRecord>([[sqliteRow.taskId, sqliteRow]]);
    const deleteTaskWithDeliveryState = vi.fn(() => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    });
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(sqliteState),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState: vi.fn(),
        deleteTaskWithDeliveryState,
      },
    });

    expect(findTaskByRunId(sqliteRow.runId)?.taskId).toBe(sqliteRow.taskId);
    expect(deleteTaskRecordById(sqliteRow.taskId)).toBe(false);

    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(sqliteRow.taskId);
    expect(getTaskById(sqliteRow.taskId)?.status).toBe("running");
  });

  it("deletes through a single atomic store call", () => {
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        ...createInMemoryTaskRegistryStore(),
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        upsertTaskWithDeliveryState: vi.fn(),
        deleteTaskWithDeliveryState,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-atomic-delete",
      task: "Atomic delete task",
      status: "running",
      deliveryStatus: "pending",
    });

    expect(deleteTaskRecordById(created.taskId)).toBe(true);

    expect(deleteTaskWithDeliveryState).toHaveBeenCalledTimes(1);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
    expect(getTaskById(created.taskId)).toBeUndefined();
  });

  it.each(["create", "update", "delete"] as const)(
    "keeps SQLite and published task state atomic when %s persistence fails",
    async (operation) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: `openclaw-task-atomic-${operation}-` },
        async () => {
          resetTaskRegistryForTests({ persist: false });
          const params = {
            runtime: "cli" as const,
            ownerKey: "agent:main:main",
            scopeKind: "session" as const,
            runId: `atomic-${operation}`,
            task: "Preserve task and delivery state together",
            status: "running" as const,
            deliveryStatus: "pending" as const,
            notifyPolicy: "silent" as const,
            requesterOrigin: { channel: "test-channel", to: "C1234567890" },
          };
          const existing = operation === "create" ? undefined : createTaskRecord(params);
          const visibleBefore = listTaskRecords();
          const storedBefore = loadTaskRegistryStateFromSqlite();
          const observed: Array<{
            kind: TaskRegistryObserverEvent["kind"];
            stored: ReturnType<typeof loadTaskRegistryStateFromSqlite>;
            visible: TaskRecord[];
          }> = [];
          configureTaskRegistryRuntime({
            observers: {
              onEvent: (event) => {
                observed.push({
                  kind: event.kind,
                  stored: loadTaskRegistryStateFromSqliteReadOnly(),
                  visible: listTaskRecords(),
                });
              },
            },
          });
          const mutate = () => {
            if (operation === "create") {
              return createTaskRecordOrNull(params);
            }
            if (!existing) {
              throw new Error("expected the existing task fixture");
            }
            return operation === "update"
              ? updateTaskNotifyPolicyById({
                  taskId: existing.taskId,
                  notifyPolicy: "state_changes",
                })
              : deleteTaskRecordById(existing.taskId);
          };
          const { db } = openOpenClawStateDatabase();
          const failingStatement =
            operation === "delete" ? "DELETE ON task_runs" : "INSERT ON task_delivery_state";
          // Fail the second statement: a missing transaction would leave the first row change behind.
          db.exec(`
            CREATE TEMP TRIGGER reject_task_write BEFORE ${failingStatement}
            BEGIN SELECT RAISE(ABORT, 'synthetic task write failure'); END;
          `);
          try {
            expect(mutate()).toBe(operation === "delete" ? false : null);
            expect(loadTaskRegistryStateFromSqlite()).toEqual(storedBefore);
            expect(listTaskRecords()).toEqual(visibleBefore);
            expect(findTaskByRunId(params.runId)).toEqual(existing);
            expect(observed).toEqual([]);
          } finally {
            db.exec("DROP TRIGGER reject_task_write");
          }

          const result = mutate();
          expect(result).not.toBeNull();
          expect(result).not.toBe(false);
          const storedAfter = loadTaskRegistryStateFromSqlite();
          if (operation === "delete") {
            expect(storedAfter.tasks.size).toBe(0);
            expect(storedAfter.deliveryStates.size).toBe(0);
            expect(findTaskByRunId(params.runId)).toBeUndefined();
          } else {
            const current = findTaskByRunId(params.runId);
            expect(current).toMatchObject({
              notifyPolicy: operation === "update" ? "state_changes" : "silent",
            });
            expect(storedAfter.tasks.get(current?.taskId ?? "")).toMatchObject({
              task: params.task,
              notifyPolicy: operation === "update" ? "state_changes" : "silent",
            });
            expect(storedAfter.deliveryStates.get(current?.taskId ?? "")?.requesterOrigin).toEqual(
              params.requesterOrigin,
            );
          }
          expect(observed.map((event) => event.kind)).toEqual([
            operation === "delete" ? "deleted" : "upserted",
          ]);
          expect(observed[0]?.stored).toEqual(storedAfter);
          expect(observed[0]?.visible).toEqual(listTaskRecords());
        },
      );
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
