import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  getTaskRegistrySnapshot,
  listFreshTasksForOwnerKey,
  markTaskLostById,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
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

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
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

describe("task-registry store runtime", () => {
  afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests({ persist: false });
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

  it("persists create requester origin with separate task and delivery store methods", () => {
    const upsertTask = vi.fn();
    const upsertDeliveryState = vi.fn();
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map(),
          deliveryStates: new Map(),
        }),
        saveSnapshot: vi.fn(),
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

    expect(upsertTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: created.taskId }));
    expect(upsertDeliveryState).toHaveBeenCalledWith({
      taskId: created.taskId,
      requesterOrigin: {
        channel: "test-channel",
        to: "C1234567890",
      },
    });
    const taskCallOrder = upsertTask.mock.invocationCallOrder[0];
    const deliveryCallOrder = upsertDeliveryState.mock.invocationCallOrder[0];
    if (taskCallOrder == null || deliveryCallOrder == null) {
      throw new Error("Expected separate store upsert calls");
    }
    expect(taskCallOrder).toBeLessThan(deliveryCallOrder);
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
        const deliveryState = getTaskRegistrySnapshot().deliveryStates.find(
          (state) => state.taskId === created.taskId,
        );
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
});
