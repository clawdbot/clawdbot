import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getTaskById,
  listTaskRecordPage,
  resetTaskRegistryForTests,
} from "./task-registry-query.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
});

function configureTaskSnapshot(tasks: Iterable<TaskRecord>): void {
  const snapshotTasks = new Map([...tasks].map((task) => [task.taskId, task]));
  configureTaskRegistryRuntime({
    store: {
      loadSnapshot: () => ({ tasks: snapshotTasks, deliveryStates: new Map() }),
      saveSnapshot: () => {},
    },
  });
}

describe("listTaskRecordPage", () => {
  it("keeps large page scans responsive and sorts only the selected window", async () => {
    const total = 10_000;
    const offset = 13;
    const limit = 7;
    const snapshotTasks = new Map<string, TaskRecord>();
    for (let index = 0; index < total; index += 1) {
      const taskId = `task-${String(index).padStart(5, "0")}`;
      const lastEventAt = Math.floor(((index * 7_919) % total) / 4);
      snapshotTasks.set(taskId, {
        taskId,
        runtime: "cli",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        runId: `run-${index}`,
        task: "Bounded page selection",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        notifyPolicy: "done_only",
        createdAt: 0,
        startedAt: 0,
        lastEventAt,
      });
    }
    const expectedTaskIds = [...snapshotTasks.values()]
      .toSorted(
        (left, right) =>
          (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0) ||
          left.taskId.localeCompare(right.taskId),
      )
      .slice(offset, offset + limit)
      .map((task) => task.taskId);
    configureTaskSnapshot(snapshotTasks.values());

    let eventLoopTurnRan = false;
    const sortSpy = vi.spyOn(Array.prototype, "toSorted");
    try {
      setImmediate(() => {
        eventLoopTurnRan = true;
      });
      const page = await listTaskRecordPage({ offset, limit });

      expect(page.tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
      expect(page.hasMore).toBe(true);
      expect(eventLoopTurnRan).toBe(true);
      const taskSortSizes = sortSpy.mock.instances
        .filter(
          (values) =>
            values.length > 0 &&
            typeof values[0] === "object" &&
            values[0] !== null &&
            "taskId" in values[0],
        )
        .map((values) => values.length);
      expect(Math.max(0, ...taskSortSizes)).toBeLessThanOrEqual(offset + limit);

      sortSpy.mockClear();
      const emptyPage = await listTaskRecordPage({ offset: total + 1, limit: 1 });
      expect(emptyPage).toEqual({ tasks: [], hasMore: false });
      expect(
        sortSpy.mock.instances.filter(
          (values) =>
            values.length > 0 &&
            typeof values[0] === "object" &&
            values[0] !== null &&
            "taskId" in values[0],
        ),
      ).toEqual([]);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it("does not use the executor as the requester owner for a legacy bare task", async () => {
    const task: TaskRecord = {
      taskId: "task-legacy-owner",
      runtime: "subagent",
      requesterSessionKey: "global",
      ownerKey: "global",
      scopeKind: "session",
      childSessionKey: "agent:research:subagent:child",
      agentId: "research",
      runId: "run-legacy-owner",
      task: "Owned by ops, executed by research",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1,
    };
    configureTaskSnapshot([task]);
    const cfg = {
      session: { scope: "global", store: "/tmp/shared-sessions.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(
      (
        await listTaskRecordPage({
          offset: 0,
          limit: 10,
          sessionKey: "global",
          sessionAgentId: "ops",
          cfg,
        })
      ).tasks.map((entry) => entry.taskId),
    ).toEqual([task.taskId]);
    expect(
      (
        await listTaskRecordPage({
          offset: 0,
          limit: 10,
          sessionKey: "global",
          sessionAgentId: "research",
          cfg,
        })
      ).tasks,
    ).toEqual([]);
  });

  it("returns page records isolated from the registry", async () => {
    const task: TaskRecord = {
      taskId: "task-isolated",
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Isolated task",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1,
      detail: { nested: { value: "original" } },
    };
    configureTaskSnapshot([task]);

    const page = await listTaskRecordPage({ offset: 0, limit: 1 });
    const detail = page.tasks[0]?.detail as { nested: { value: string } } | undefined;
    expect(detail).toBeDefined();
    if (detail) {
      detail.nested.value = "mutated";
    }

    expect(getTaskById(task.taskId)?.detail).toEqual({ nested: { value: "original" } });
  });
});
