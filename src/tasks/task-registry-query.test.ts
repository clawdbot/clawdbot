import { afterEach, describe, expect, it, vi } from "vitest";
import { listTaskRecordPage, resetTaskRegistryForTests } from "./task-registry-query.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
});

describe("listTaskRecordPage", () => {
  it("sorts only the requested task page window", () => {
    const total = 10_000;
    const snapshotTasks = new Map<string, TaskRecord>();
    let expectedNewestTaskId = "";
    let expectedNewestAt = -1;
    for (let index = 0; index < total; index += 1) {
      const taskId = `task-${String(index).padStart(5, "0")}`;
      const lastEventAt = (index * 7_919) % total;
      if (lastEventAt > expectedNewestAt) {
        expectedNewestAt = lastEventAt;
        expectedNewestTaskId = taskId;
      }
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
        createdAt: index,
        startedAt: index,
        lastEventAt,
      });
    }
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({ tasks: snapshotTasks, deliveryStates: new Map() }),
        saveSnapshot: () => {},
      },
    });

    const originalToSorted = Array.prototype.toSorted;
    const sortedInputLengths: number[] = [];
    const sortSpy = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function (
      this: unknown[],
      compareFn?: (left: unknown, right: unknown) => number,
    ) {
      sortedInputLengths.push(this.length);
      return Reflect.apply(originalToSorted, this, [compareFn]) as unknown[];
    } as typeof Array.prototype.toSorted);
    try {
      const page = listTaskRecordPage({ offset: 0, limit: 1 });

      expect(page.tasks.map((task) => task.taskId)).toEqual([expectedNewestTaskId]);
      expect(page.hasMore).toBe(true);
      expect(sortedInputLengths).toEqual([1]);
    } finally {
      sortSpy.mockRestore();
    }
  });
});
