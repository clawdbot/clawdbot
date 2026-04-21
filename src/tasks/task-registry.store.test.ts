import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import {
  createTaskRecord,
  deleteTaskRecordById,
  findTaskByRunId,
  markTaskLostById,
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
} from "./task-registry.js";
import { resolveTaskRegistryDir, resolveTaskRegistrySqlitePath } from "./task-registry.paths.js";
import {
  configureTaskRegistryRuntime,
  type TaskRegistryObserverEvent,
} from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

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
    delete process.env.OPENCLAW_STATE_DIR;
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
    const latestSnapshot = saveSnapshot.mock.calls.at(-1)?.[0] as {
      tasks: ReadonlyMap<string, TaskRecord>;
    };
    expect(latestSnapshot.tasks.size).toBe(2);
    expect(latestSnapshot.tasks.get("task-restored")?.task).toBe("Restored task");
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

    expect(findTaskByRunId("run-restored")).toBeTruthy();
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
    expect(upsertTaskWithDeliveryState.mock.calls[0]?.[0]).toMatchObject({
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

  it("hardens the sqlite task store directory and file modes", () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

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

    const registryDir = resolveTaskRegistryDir(process.env);
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    expect(statSync(registryDir).mode & 0o777).toBe(0o700);
    expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);

    resetTaskRegistryForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("migrates legacy ownerless cron rows to system scope", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-legacy-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
    db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        source_id,
        requester_session_key,
        child_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-cron-task",
      "cron",
      "nightly-digest",
      "",
      "agent:main:cron:nightly-digest",
      "legacy-cron-run",
      "Nightly digest",
      "running",
      "not_applicable",
      "silent",
      100,
      100,
    );
    db.close();

    resetTaskRegistryForTests({ persist: false });

    expect(findTaskByRunId("legacy-cron-run")).toMatchObject({
      taskId: "legacy-cron-task",
      ownerKey: "system:cron:nightly-digest",
      scopeKind: "system",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
    });
  });

  it("keeps legacy requester_session_key rows writable after restore", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-task-store-legacy-write-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE task_runs (
        task_id TEXT PRIMARY KEY,
        runtime TEXT NOT NULL,
        source_id TEXT,
        requester_session_key TEXT NOT NULL,
        child_session_key TEXT,
        parent_task_id TEXT,
        agent_id TEXT,
        run_id TEXT,
        label TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_event_at INTEGER,
        cleanup_after INTEGER,
        error TEXT,
        progress_summary TEXT,
        terminal_summary TEXT,
        terminal_outcome TEXT
      );
    `);
    db.exec(`
      CREATE TABLE task_delivery_state (
        task_id TEXT PRIMARY KEY,
        requester_origin_json TEXT,
        last_notified_event_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO task_runs (
        task_id,
        runtime,
        requester_session_key,
        run_id,
        task,
        status,
        delivery_status,
        notify_policy,
        created_at,
        last_event_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-session-task",
      "acp",
      "agent:main:main",
      "legacy-session-run",
      "Legacy session task",
      "running",
      "pending",
      "done_only",
      100,
      100,
    );
    db.close();

    resetTaskRegistryForTests({ persist: false });

    expect(() =>
      markTaskLostById({
        taskId: "legacy-session-task",
        endedAt: 200,
        lastEventAt: 200,
        error: "session missing",
      }),
    ).not.toThrow();
    expect(findTaskByRunId("legacy-session-run")).toMatchObject({
      taskId: "legacy-session-task",
      status: "lost",
      error: "session missing",
    });
  });
});
