import { afterEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  createTaskRecord as createTaskRecordOrNull,
  getTaskById,
  listTaskRecordsUnsorted,
} from "./task-registry.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

const ORIGINAL_ENV = captureEnv(["OPENCLAW_STATE_DIR"]);

function createTaskRecord(params: Parameters<typeof createTaskRecordOrNull>[0]): TaskRecord {
  const task = createTaskRecordOrNull(params);
  if (!task) {
    throw new Error("expected task creation to succeed");
  }
  return task;
}

/** Test-local clone probe: `{...record}` triggers ownKeys; property reads for filters do not. */
function wrapWithCloneProbe(record: TaskRecord, probe: { clones: number }): TaskRecord {
  return new Proxy(record, {
    ownKeys(target) {
      probe.clones += 1;
      return Reflect.ownKeys(target);
    },
  });
}

function createStoredTask(overrides: Partial<TaskRecord> & Pick<TaskRecord, "taskId">): TaskRecord {
  return {
    taskId: overrides.taskId,
    runtime: "acp",
    sourceId: overrides.runId ?? `run-${overrides.taskId}`,
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    childSessionKey: overrides.childSessionKey ?? `agent:codex:acp:${overrides.taskId}`,
    runId: overrides.runId ?? `run-${overrides.taskId}`,
    agentId: overrides.agentId,
    task: overrides.task ?? `Task ${overrides.taskId}`,
    status: overrides.status ?? "succeeded",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: overrides.createdAt ?? 100,
    lastEventAt: overrides.lastEventAt ?? 100,
    progressSummary: overrides.progressSummary,
  };
}

describe("listTaskRecordsUnsorted early filter", () => {
  afterEach(() => {
    ORIGINAL_ENV.restore();
    resetTaskRegistryForTests({ persist: false });
  });

  it("clones only matching records when a filter is provided", () => {
    const probe = { clones: 0 };
    const tasks = new Map<string, TaskRecord>();
    for (let i = 0; i < 20; i++) {
      const taskId = `task-filter-${i}`;
      const base = createStoredTask({
        taskId,
        agentId: i === 7 ? "keep-me" : `other-${i}`,
        status: i === 7 ? "running" : "succeeded",
        childSessionKey: `agent:codex:acp:filter-${i}`,
        runId: `run-filter-${i}`,
      });
      tasks.set(taskId, wrapWithCloneProbe(base, probe));
    }

    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({ tasks, deliveryStates: new Map() }),
        saveSnapshot: () => {},
      },
    });

    expect(getTaskById("task-filter-0")?.taskId).toBe("task-filter-0");
    probe.clones = 0;

    const matched = listTaskRecordsUnsorted(
      (task) => task.agentId === "keep-me" && task.status === "running",
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.agentId).toBe("keep-me");
    expect(probe.clones).toBe(1);

    probe.clones = 0;
    const all = listTaskRecordsUnsorted();
    expect(all).toHaveLength(20);
    expect(probe.clones).toBe(20);
  });

  it("returns detached snapshots for filtered matches", () => {
    resetTaskRegistryForTests({ persist: false });
    const created = createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      agentId: "keep-me",
      childSessionKey: "agent:codex:acp:detach",
      runId: "run-detach",
      task: "detach me",
      status: "running",
      deliveryStatus: "pending",
      progressSummary: "original",
    });

    const [snapshot] = listTaskRecordsUnsorted((task) => task.taskId === created.taskId);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toBe(created);

    snapshot!.progressSummary = "mutated-snapshot";
    expect(getTaskById(created.taskId)?.progressSummary).toBe("original");
  });
});
