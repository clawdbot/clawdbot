// Covers task registry store persistence, in-memory behavior, and observer notifications.
import { statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedTaskFlow as createManagedTaskFlowOrNull } from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskById,
  listFreshTasksForOwnerKey,
  markTaskTerminalById,
  reloadTaskRegistryFromStore,
  updateTaskNotifyPolicyById,
} from "./task-registry.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import {
  loadTaskRegistryStateFromSqlite,
  saveTaskRegistryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
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

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

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
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    loggingState.rawConsole = null;
    setLoggerOverride(null);
    resetLogger();
  });

  it("uses the configured task store for restore and save", () => {
    const storedTask = createStoredTask();
    const loadSnapshot = vi.fn(() => ({
      tasks: new Map([[storedTask.taskId, storedTask]]),
      deliveryStates: new Map(),
    }));
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
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

    expect(saveSnapshot).toHaveBeenCalled();
    const latestSnapshot = saveSnapshot.mock.calls[saveSnapshot.mock.calls.length - 1]?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
    };
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
          loadSnapshot,
          saveSnapshot: () => {},
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
        loadSnapshot: () => {
          throw new Error(
            `Invalid persisted task delivery status: ${JSON.stringify(invalidValue)}`,
          );
        },
        saveSnapshot: () => {},
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
        loadSnapshot,
        saveSnapshot: () => {},
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
        loadSnapshot: failedLoad,
        saveSnapshot: () => {},
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
        loadSnapshot: cleanLoad,
        saveSnapshot: () => {},
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
        loadSnapshot,
        saveSnapshot: () => {},
        listTasksForOwnerKey,
      },
    });

    const tasks = listFreshTasksForOwnerKey("agent:main:main");

    expect(tasks.map((task) => task.taskId)).toEqual(["task-restored"]);
    expect(listTasksForOwnerKey).toHaveBeenCalledWith("agent:main:main");
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid persisted task enum values", () => {
    expect(parseTaskRuntime("cron")).toBe("cron");
    expect(parseTaskScopeKind("system")).toBe("system");
    expect(parseTaskStatus("running")).toBe("running");
    expect(parseTaskDeliveryStatus("pending")).toBe("pending");
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

  it("rejects corrupt persisted task rows during sqlite restore", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-corrupt-" },
      async () => {
        resetTaskRegistryForTests();
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
        resetTaskRegistryForTests();
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
        saveTaskRegistryStateToSqlite({
          tasks: new Map([[task.taskId, task]]),
          deliveryStates: new Map(),
        });

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
        saveTaskRegistryStateToSqlite({
          tasks: new Map([[task.taskId, task]]),
          deliveryStates: new Map(),
        });

        const restored = loadTaskRegistryStateFromSqlite().tasks.get(task.taskId);
        expect(restored).toHaveProperty("detail", null);
      },
    );
  });

  it("loads task and delivery rows from one sqlite read snapshot", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-read-snapshot-" },
      async () => {
        resetTaskRegistryForTests();
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
        resetTaskRegistryForTests();
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
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
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

  it("uses atomic task-plus-delivery store methods when available", async () => {
    const upsertTaskWithDeliveryState = vi.fn();
    const deleteTaskWithDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: vi.fn(),
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

  it("persists create requester origin with one projected snapshot when only separate upserts exist", () => {
    const upsertTask = vi.fn();
    const upsertDeliveryState = vi.fn();
    const saveSnapshot = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot,
        upsertTask,
        upsertDeliveryState,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:new",
      runId: "run-separate-store-origin",
      task: "Separate store task",
      status: "running",
      deliveryStatus: "pending",
      requesterOrigin: {
        channel: "test-channel",
        to: "C1234567890",
      },
    });

    expect(upsertTask).not.toHaveBeenCalled();
    expect(upsertDeliveryState).not.toHaveBeenCalled();
    expect(saveSnapshot).toHaveBeenCalledOnce();
    const snapshot = saveSnapshot.mock.calls[0]?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
      deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
    };
    expect(snapshot.tasks.get(created.taskId)?.task).toBe("Separate store task");
    expect(snapshot.deliveryStates.get(created.taskId)?.requesterOrigin).toEqual({
      channel: "test-channel",
      to: "C1234567890",
    });
  });

  it("falls back to full snapshots when custom stores cannot upsert delivery state", () => {
    const saveSnapshot = vi.fn();
    const upsertTask = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot,
        upsertTask,
      },
    });

    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: "agent:codex:acp:snapshot-fallback",
      runId: "run-snapshot-fallback-origin",
      task: "Snapshot fallback task",
      status: "running",
      deliveryStatus: "pending",
      requesterOrigin: {
        channel: "test-channel",
        to: "C1234567890",
      },
    });

    expect(upsertTask).not.toHaveBeenCalled();
    expect(saveSnapshot).toHaveBeenCalledOnce();
    const snapshot = saveSnapshot.mock.calls[0]?.[0] as {
      deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
    };
    expect(snapshot.deliveryStates.get(created.taskId)?.requesterOrigin).toEqual({
      channel: "test-channel",
      to: "C1234567890",
    });
  });

  it("projects updated tasks into snapshots when custom stores cannot upsert delivery state", () => {
    const storedTask = createStoredTask();
    const requesterOrigin = {
      channel: "test-channel",
      to: "C1234567890",
    };
    const snapshots: Array<{
      tasks: ReadonlyMap<string, TaskRecord>;
      deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
    }> = [];
    const saveSnapshot = vi.fn(
      (snapshot: {
        tasks: ReadonlyMap<string, TaskRecord>;
        deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
      }) => {
        snapshots.push({
          tasks: new Map(snapshot.tasks),
          deliveryStates: new Map(snapshot.deliveryStates),
        });
      },
    );
    const upsertTask = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[storedTask.taskId, storedTask]]),
          deliveryStates: new Map([
            [
              storedTask.taskId,
              {
                taskId: storedTask.taskId,
                requesterOrigin,
              },
            ],
          ]),
        }),
        saveSnapshot,
        upsertTask,
      },
    });

    expect(findTaskByRunId("run-restored")?.taskId).toBe(storedTask.taskId);
    expect(
      updateTaskNotifyPolicyById({
        taskId: storedTask.taskId,
        notifyPolicy: "state_changes",
      })?.notifyPolicy,
    ).toBe("state_changes");

    expect(upsertTask).not.toHaveBeenCalled();
    const latestSnapshot = snapshots.at(-1);
    expect(latestSnapshot?.tasks.get(storedTask.taskId)?.notifyPolicy).toBe("state_changes");
    expect(latestSnapshot?.deliveryStates.get(storedTask.taskId)?.requesterOrigin).toEqual(
      requesterOrigin,
    );
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

  it("prunes stale sqlite delivery state while retaining current rows", async () => {
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

        saveTaskRegistryStateToSqlite({
          tasks: new Map([
            [taskA.taskId, taskA],
            [taskB.taskId, taskB],
          ]),
          deliveryStates: new Map([
            [deliveryA.taskId, deliveryA],
            [deliveryB.taskId, deliveryB],
          ]),
        });

        saveTaskRegistryStateToSqlite({
          tasks: new Map([
            [taskA.taskId, taskA],
            [taskB.taskId, taskB],
          ]),
          deliveryStates: new Map([[deliveryB.taskId, deliveryB]]),
        });

        const restored = loadTaskRegistryStateFromSqlite();
        expect(restored.deliveryStates.has(taskA.taskId)).toBe(false);
        expect(restored.deliveryStates.get(taskB.taskId)).toEqual(deliveryB);
      },
    );
  });

  it("prunes large sqlite snapshots without binding every task id at once", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-large-prune-" },
      async () => {
        const tasks = new Map<string, TaskRecord>();
        const deliveryStates = new Map<string, TaskDeliveryState>();
        for (let index = 0; index < 1_200; index++) {
          const task: TaskRecord = {
            ...createStoredTask(),
            taskId: `task-large-${index}`,
            runId: `run-large-${index}`,
            createdAt: index,
            lastEventAt: index,
          };
          tasks.set(task.taskId, task);
          deliveryStates.set(task.taskId, {
            taskId: task.taskId,
            lastNotifiedEventAt: index,
          });
        }

        saveTaskRegistryStateToSqlite({ tasks, deliveryStates });
        const retainedTasks = new Map([...tasks].slice(100));
        const retainedDeliveryStates = new Map([...deliveryStates].slice(100));
        saveTaskRegistryStateToSqlite({
          tasks: retainedTasks,
          deliveryStates: retainedDeliveryStates,
        });

        const restored = loadTaskRegistryStateFromSqlite();
        expect(restored.tasks.size).toBe(1_100);
        expect(restored.deliveryStates.size).toBe(1_100);
        expect(restored.tasks.has("task-large-0")).toBe(false);
        expect(restored.tasks.has("task-large-1199")).toBe(true);
      },
    );
  });

  it("reopens after the shared state database is closed", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-task-store-" },
      async () => {
        const task = createStoredTask();
        saveTaskRegistryStateToSqlite({
          tasks: new Map([[task.taskId, task]]),
          deliveryStates: new Map(),
        });

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
        loadSnapshot: () => ({
          tasks: new Map(sqliteState),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
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
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
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
        loadSnapshot: () => ({
          tasks: new Map([[first.taskId, first]]),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
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
        loadSnapshot: () => ({
          tasks: new Map(sqliteState),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
        upsertTaskWithDeliveryState: vi.fn(),
        deleteTaskWithDeliveryState,
      },
    });

    expect(findTaskByRunId(sqliteRow.runId)?.taskId).toBe(sqliteRow.taskId);
    expect(deleteTaskRecordById(sqliteRow.taskId)).toBe(false);

    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(sqliteRow.taskId);
    expect(getTaskById(sqliteRow.taskId)?.status).toBe("running");
  });

  it("deletes through a single atomic store call without a redundant delivery-state delete", () => {
    const deleteTaskWithDeliveryState = vi.fn();
    const deleteDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
        upsertTaskWithDeliveryState: vi.fn(),
        deleteTaskWithDeliveryState,
        deleteDeliveryState,
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

    // The composite delete already removes the task and its delivery state in a
    // single transaction. A second, non-transactional delivery-state delete
    // before the in-memory mutation would re-open the divergence window (sqlite
    // deleted / memory retained) if it threw, so it must not be issued.
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledTimes(1);
    expect(deleteTaskWithDeliveryState).toHaveBeenCalledWith(created.taskId);
    expect(deleteDeliveryState).not.toHaveBeenCalled();
  });

  it("persists snapshot-only deletes without resurrecting the task", () => {
    const persistedTaskIds: string[][] = [];
    const persistedDeliveryIds: string[][] = [];
    const saveSnapshot = vi.fn(
      (snapshot: {
        tasks: ReadonlyMap<string, TaskRecord>;
        deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
      }) => {
        // Capture the keys at call time. A real store serializes the snapshot
        // immediately; holding the live map reference would let the in-memory
        // delete (which runs after persistence) mask a resurrected row.
        persistedTaskIds.push([...snapshot.tasks.keys()]);
        persistedDeliveryIds.push([...snapshot.deliveryStates.keys()]);
      },
    );
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map<string, TaskDeliveryState>([
            ["task-restored", { taskId: "task-restored", lastNotifiedEventAt: 100 }],
          ]),
        }),
        saveSnapshot,
      },
    });

    // Trigger restore so the task and its delivery state are loaded into memory.
    expect(findTaskByRunId("run-restored")?.taskId).toBe("task-restored");

    expect(deleteTaskRecordById("task-restored")).toBe(true);

    // A snapshot-only store persists the delete by saving a projected snapshot.
    // The final persisted snapshot must exclude both the task and its delivery
    // state; saving the task and delivery deletions as two separate snapshots
    // would let the second save (built from the un-projected in-memory maps)
    // resurrect the row the first save removed.
    expect(saveSnapshot).toHaveBeenCalled();
    expect(persistedTaskIds.at(-1)).not.toContain("task-restored");
    expect(persistedDeliveryIds.at(-1)).not.toContain("task-restored");
  });

  it("persists deletes atomically for non-composite stores with separate delete methods", () => {
    const backing = {
      tasks: new Map<string, TaskRecord>(),
      deliveryStates: new Map<string, TaskDeliveryState>(),
    };
    const deleteTask = vi.fn((taskId: string) => {
      backing.tasks.delete(taskId);
    });
    const deleteDeliveryState = vi.fn((taskId: string) => {
      backing.deliveryStates.delete(taskId);
    });
    const saveSnapshot = vi.fn(
      (snapshot: {
        tasks: ReadonlyMap<string, TaskRecord>;
        deliveryStates: ReadonlyMap<string, TaskDeliveryState>;
      }) => {
        backing.tasks = new Map(snapshot.tasks);
        backing.deliveryStates = new Map(snapshot.deliveryStates);
      },
    );
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[createStoredTask().taskId, createStoredTask()]]),
          deliveryStates: new Map<string, TaskDeliveryState>([
            ["task-restored", { taskId: "task-restored", lastNotifiedEventAt: 100 }],
          ]),
        }),
        saveSnapshot,
        // Non-composite store: separate task / delivery-state deletes, no
        // deleteTaskWithDeliveryState.
        deleteTask,
        deleteDeliveryState,
      },
    });

    // Trigger restore so the task and its delivery state are loaded into memory.
    expect(findTaskByRunId("run-restored")?.taskId).toBe("task-restored");

    expect(deleteTaskRecordById("task-restored")).toBe(true);

    // Without a composite delete, the removal of both the task and its delivery
    // state is persisted atomically through one projected snapshot, so neither a
    // leftover delivery-state row nor a two-write divergence window remains.
    expect(backing.tasks.has("task-restored")).toBe(false);
    expect(backing.deliveryStates.has("task-restored")).toBe(false);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(deleteDeliveryState).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
