import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  getTaskById,
  listTaskRecordPage,
  resetTaskRegistryForTests,
} from "./task-registry-query.js";
import { markTaskTerminalById } from "./task-registry-record-api.js";
import { configureTaskRegistryRuntime } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

afterEach(() => {
  resetTaskRegistryForTests();
});

function configureTaskSnapshot(tasks: Iterable<TaskRecord>): void {
  const snapshotTasks = new Map([...tasks].map((task) => [task.taskId, task]));
  configureTaskRegistryRuntime({
    store: {
      ...createInMemoryTaskRegistryStore(),
      loadSnapshot: () => ({ tasks: snapshotTasks, deliveryStates: new Map() }),
    },
  });
}

async function readTaskPage(params: Parameters<typeof listTaskRecordPage>[0]) {
  const result = await listTaskRecordPage(params);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`task page failed: ${result.error}`);
  }
  return result.value;
}

describe("listTaskRecordPage", () => {
  it.each([
    { scope: "sparse", matching: 1 },
    { scope: "dense", matching: 65 },
  ])("keeps $scope session pages independent of unrelated task activity", async ({ matching }) => {
    configureTaskSnapshot(
      Array.from({ length: 65 }, (_, index): TaskRecord => ({
        taskId: `task-${index}`,
        runtime: "cli",
        requesterSessionKey: index < matching ? "agent:main:requested" : "agent:main:unrelated",
        ownerKey: index < matching ? "agent:main:requested" : "agent:main:unrelated",
        scopeKind: "session",
        task: "Scoped task page",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "done_only",
        createdAt: 1,
        lastEventAt: 1,
      })),
    );
    expect(getTaskById("task-0")).toBeDefined();
    let mutations = 0;
    const update = () => {
      mutations += 1;
      markTaskTerminalById({ taskId: "task-64", status: "succeeded", endedAt: mutations + 1 });
      pending = setImmediate(update);
    };
    let pending = setImmediate(update);
    try {
      const page = await listTaskRecordPage({
        offset: 0,
        limit: 1,
        sessionKey: "agent:main:requested",
      });
      if (matching === 1) {
        expect(page.ok).toBe(true);
        if (page.ok) {
          expect(page.value.tasks.map((task) => task.taskId)).toEqual(["task-0"]);
          expect(page.value.hasMore).toBe(false);
        }
      } else {
        expect(page).toEqual({ ok: false, error: "registry_changed" });
        expect(mutations).toBeGreaterThanOrEqual(3);
      }
    } finally {
      clearImmediate(pending);
    }
  });

  it.each([
    { count: 32, mutationTurn: 1, completes: true },
    { count: 64, mutationTurn: 2, completes: true },
    { count: 33, mutationTurn: 1, completes: false },
    { count: 65, mutationTurn: 2, completes: false },
  ])(
    "finishes complete batches but yields unfinished work ($count tasks)",
    async ({ count, mutationTurn, completes }) => {
      configureTaskSnapshot(
        Array.from({ length: count }, (_, index): TaskRecord => ({
          taskId: `task-${index}`,
          runtime: "cli",
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scopeKind: "session",
          task: "Task with queued activity",
          status: "running",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          createdAt: 1,
          lastEventAt: 1,
        })),
      );
      let turn = 0;
      let mutations = 0;
      const update = () => {
        turn += 1;
        if (turn >= mutationTurn) {
          mutations += 1;
          markTaskTerminalById({
            taskId: "task-0",
            status: "succeeded",
            endedAt: mutations + 1,
          });
        }
        pending = setImmediate(update);
      };
      let pending = setImmediate(update);
      try {
        const page = await listTaskRecordPage({ offset: 0, limit: count });
        if (completes) {
          expect(page.ok).toBe(true);
          expect(mutations).toBe(0);
        } else {
          expect(page).toEqual({ ok: false, error: "registry_changed" });
          expect(mutations).toBeGreaterThanOrEqual(3);
        }
      } finally {
        clearImmediate(pending);
      }
    },
  );

  it.each([
    { name: "stale cursor", continuation: true, mutate: true, failLater: false },
    { name: "cursorless retry", continuation: false, mutate: true, failLater: false },
    {
      name: "stale cursor before a later failure",
      continuation: true,
      mutate: true,
      failLater: true,
    },
    {
      name: "valid cursor with a later failure",
      continuation: true,
      mutate: false,
      failLater: true,
    },
  ])("handles yielded task pages with $name", async ({ continuation, mutate, failLater }) => {
    const tasks = Array.from({ length: 1_024 }, (_, index): TaskRecord => ({
      taskId: `task-${String(index).padStart(5, "0")}`,
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "Task page interrupted by one completion",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 1,
      lastEventAt: 1_024 - index,
    }));
    configureTaskSnapshot(tasks);
    const first = await readTaskPage({ offset: 0, limit: 25 });
    const unchanged = await readTaskPage({
      offset: 25,
      limit: 25,
      expectedRevision: first.revision,
    });
    expect(unchanged.tasks.map((task) => task.taskId)).toEqual(
      tasks.slice(25, 50).map((task) => task.taskId),
    );

    let examined = 0;
    let scheduled = false;
    let mutation: TaskRecord | null | undefined;
    const accessFailure = new Error("canonical-store collision in a later slice");
    const pendingPage = listTaskRecordPage({
      offset: continuation ? 25 : 0,
      limit: 25,
      ...(continuation ? { expectedRevision: first.revision } : {}),
      prepareFilter: (batch) => {
        examined += batch.length;
        if (failLater && examined > 32) {
          throw accessFailure;
        }
        if (mutate && !scheduled) {
          scheduled = true;
          // The ordinary completion runs only when this scan reaches its existing yield.
          queueMicrotask(() => {
            mutation = markTaskTerminalById({
              taskId: "task-01023",
              status: "succeeded",
              endedAt: 2_000,
            });
          });
        }
        return () => true;
      },
    });
    if (!mutate) {
      await expect(pendingPage).rejects.toBe(accessFailure);
      return;
    }
    const page = await pendingPage;
    expect(mutation).toMatchObject({ taskId: "task-01023", status: "succeeded" });
    if (continuation) {
      expect(page).toEqual({ ok: false, error: "cursor_stale" });
      expect(examined).toBe(32);
    } else {
      expect(page.ok).toBe(true);
      if (page.ok) {
        expect(page.value.tasks.map((task) => task.taskId)).toEqual([
          "task-01023",
          ...tasks.slice(0, 24).map((task) => task.taskId),
        ]);
        expect(page.value.revision).toBeGreaterThan(first.revision);
      }
    }
  });

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
    const sortedInputLengths: number[] = [];
    const originalToSorted = Array.prototype.toSorted;
    const sortSpy = vi.spyOn(Array.prototype, "toSorted").mockImplementation(function <T>(
      this: T[],
      compareFn?: (left: T, right: T) => number,
    ): T[] {
      const first = this[0];
      if (first && typeof first === "object" && "taskId" in first) {
        sortedInputLengths.push(this.length);
      }
      return Reflect.apply(originalToSorted, this, [compareFn]) as T[];
    });
    try {
      setImmediate(() => {
        eventLoopTurnRan = true;
      });
      const page = await readTaskPage({ offset, limit });

      expect(page.tasks.map((task) => task.taskId)).toEqual(expectedTaskIds);
      expect(page.hasMore).toBe(true);
      expect(eventLoopTurnRan).toBe(true);
      expect(Math.max(0, ...sortedInputLengths)).toBeLessThanOrEqual(offset + limit);

      sortedInputLengths.length = 0;
      const emptyPage = await readTaskPage({ offset: total + 1, limit: 1 });
      expect(emptyPage).toMatchObject({ tasks: [], hasMore: false });
      expect(sortedInputLengths).toEqual([]);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it("selects the terminal page by completion instead of later activity", async () => {
    const tasks = [
      {
        taskId: "finished-newest",
        endedAt: 300,
        lastEventAt: 100,
      },
      {
        taskId: "legacy-terminal",
        endedAt: undefined,
        lastEventAt: 250,
      },
      {
        taskId: "finished-middle",
        endedAt: 200,
        lastEventAt: 200,
      },
    ].map(({ taskId, endedAt, lastEventAt }): TaskRecord => ({
      taskId,
      runtime: "cli",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: taskId,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 0,
      endedAt,
      lastEventAt,
    }));
    configureTaskSnapshot(tasks);

    const page = await readTaskPage({ offset: 0, limit: 2, sortBy: "endedAt" });

    expect(page.tasks.map((task) => task.taskId)).toEqual(["finished-newest", "legacy-terminal"]);
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
        await readTaskPage({
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
        await readTaskPage({
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

    const page = await readTaskPage({ offset: 0, limit: 1 });
    const detail = page.tasks[0]?.detail as { nested: { value: string } } | undefined;
    expect(detail).toBeDefined();
    if (detail) {
      detail.nested.value = "mutated";
    }

    expect(getTaskById(task.taskId)?.detail).toEqual({ nested: { value: "original" } });
  });
});
