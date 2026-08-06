import { describe, expect, it } from "vitest";
import {
  applyTaskEvent,
  mergeTaskLists,
  newestTaskSnapshot,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  normalizeTasksRecoveryResult,
  partitionTasks,
  sortTasks,
} from "./data.ts";
import type { TaskSummary } from "./task-summary.ts";

function task(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id" | "status">): TaskSummary {
  return {
    taskId: overrides.id,
    updatedAt: 100,
    ...overrides,
  };
}

describe("tasks page data", () => {
  it("sorts by updated time descending with an id tiebreak", () => {
    const sorted = sortTasks([
      task({ id: "b", status: "queued", updatedAt: 200 }),
      task({ id: "c", status: "completed", updatedAt: 300 }),
      task({ id: "a", status: "running", updatedAt: 200 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("partitions active tasks and caps recent terminal tasks at 50", () => {
    const terminals = Array.from({ length: 55 }, (_, index) =>
      task({ id: `terminal-${index}`, status: "completed", updatedAt: index }),
    );
    const result = partitionTasks([
      task({ id: "running", status: "running", updatedAt: 1000 }),
      task({ id: "queued", status: "queued", updatedAt: 999 }),
      ...terminals,
    ]);
    expect(result.active.map((entry) => entry.id)).toEqual(["running", "queued"]);
    expect(result.recent).toHaveLength(50);
    expect(result.recent[0]?.id).toBe("terminal-54");
  });

  it("merges task lists by id while preserving newer running snapshots", () => {
    const recentPage = [
      task({ id: "new-terminal", status: "completed", updatedAt: 900 }),
      task({ id: "shared", status: "running", updatedAt: 800 }),
    ];
    const activePage = [
      task({ id: "shared", status: "running", updatedAt: 850 }),
      task({ id: "old-running", status: "running", updatedAt: 10 }),
    ];
    const merged = mergeTaskLists(recentPage, activePage);
    expect(merged.map((entry) => entry.id)).toEqual(["new-terminal", "shared", "old-running"]);
    expect(merged.find((entry) => entry.id === "shared")?.updatedAt).toBe(850);
  });

  it("keeps ten completed same-title tasks distinct when the active page is stale", () => {
    const recentPage = Array.from({ length: 10 }, (_, index) =>
      task({
        id: `task-${index}`,
        status: "completed",
        title: "Concurrent background task",
        updatedAt: 2_000 + index,
      }),
    );
    const staleActivePage = recentPage.map((completed) =>
      task({
        id: completed.id,
        status: "running",
        title: completed.title,
        updatedAt: 1_000,
      }),
    );

    const merged = mergeTaskLists(recentPage, staleActivePage);

    expect(merged).toHaveLength(10);
    expect(new Set(merged.map((entry) => entry.id)).size).toBe(10);
    expect(merged.every((entry) => entry.status === "completed")).toBe(true);
    expect(partitionTasks(merged).active).toEqual([]);
  });

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "preserves an equally recent %s snapshot regardless of page order",
    (status) => {
      const terminal = task({ id: "shared", status, updatedAt: 200 });
      const running = task({ id: "shared", status: "running", updatedAt: 200 });

      expect(mergeTaskLists([terminal], [running])).toEqual([terminal]);
      expect(mergeTaskLists([running], [terminal])).toEqual([terminal]);
    },
  );

  it("advances equally recent queued snapshots to running regardless of page order", () => {
    const queued = task({ id: "shared", status: "queued", updatedAt: 200 });
    const running = task({ id: "shared", status: "running", updatedAt: 200 });

    expect(mergeTaskLists([queued], [running])).toEqual([running]);
    expect(mergeTaskLists([running], [queued])).toEqual([running]);
  });

  it("keeps the incoming running progress when both pages share a timestamp", () => {
    const previous = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
    });
    const progress = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
    });

    expect(mergeTaskLists([previous], [progress])).toEqual([progress]);
  });

  it("keeps the later page's equally current tool progress at the same tool count", () => {
    const previous = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Preparing the concurrent task report",
    });
    const progress = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing the concurrent task report",
    });

    expect(mergeTaskLists([previous], [progress])).toEqual([progress]);
  });

  it("does not roll back running tool progress from an equally recent stale page", () => {
    const progress = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
    });
    const stale = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
    });

    expect(mergeTaskLists([progress], [stale])).toEqual([progress]);
    expect(mergeTaskLists([stale], [progress])).toEqual([progress]);
  });

  it("preserves an equally current opened task detail", () => {
    const running = task({ id: "shared", status: "running", updatedAt: 200 });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual(detail);
  });

  it("retains current tool progress while adopting an opened task prompt", () => {
    const running = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Writing the concurrent task report",
    });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
      progressSummary: "Reading the concurrent task report",
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual({
      ...running,
      prompt: detail.prompt,
    });
  });

  it("does not let an equally current opened detail roll back tool progress", () => {
    const running = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Finishing the concurrent task report",
    });
    const detail = task({
      id: "shared",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
      progressSummary: "Preparing the concurrent task report",
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(running, detail)).toEqual({
      ...running,
      prompt: detail.prompt,
    });
  });

  it("keeps current terminal output when an equally current detail is stale", () => {
    const completed = task({
      id: "shared",
      status: "completed",
      updatedAt: 200,
      terminalSummary: "Audit complete",
    });
    const detail = task({
      id: "shared",
      status: "completed",
      updatedAt: 200,
      terminalSummary: "Stale running progress",
      prompt: "Inspect the concurrent task owner",
    });

    expect(newestTaskSnapshot(completed, detail)).toEqual(completed);
  });

  it("accepts a genuinely newer running snapshot from the active page", () => {
    const oldRunning = task({ id: "shared", status: "running", updatedAt: 100 });
    const newRunning = task({ id: "shared", status: "running", updatedAt: 200 });

    expect(mergeTaskLists([oldRunning], [newRunning])).toEqual([newRunning]);
    expect(mergeTaskLists([newRunning], [oldRunning])).toEqual([newRunning]);
  });

  it("normalizes cancel results including refusals with reasons", () => {
    expect(
      normalizeTasksCancelResult({
        found: true,
        cancelled: false,
        reason: "task already finished",
        task: { id: "task-1", taskId: "task-1", status: "completed" },
      }),
    ).toEqual({
      found: true,
      cancelled: false,
      reason: "task already finished",
      task: { id: "task-1", taskId: "task-1", status: "completed" },
    });
    expect(normalizeTasksCancelResult({ found: true, cancelled: true })).toEqual({
      found: true,
      cancelled: true,
    });
    expect(normalizeTasksCancelResult({ found: true })).toBeNull();
    expect(normalizeTasksCancelResult("nope")).toBeNull();
  });

  it("normalizes bounded completion-delivery recovery results", () => {
    expect(
      normalizeTasksRecoveryResult({
        results: [
          {
            taskId: "task-1",
            ok: true,
            duplicateRisk: true,
            task: {
              id: "task-1",
              taskId: "task-1",
              status: "completed",
              deliveryStatus: "session_queued",
              terminalOutcome: "succeeded",
            },
          },
        ],
      }),
    ).toEqual({
      results: [
        {
          taskId: "task-1",
          ok: true,
          duplicateRisk: true,
          task: {
            id: "task-1",
            taskId: "task-1",
            status: "completed",
            deliveryStatus: "session_queued",
            terminalOutcome: "succeeded",
          },
        },
      ],
    });
    expect(normalizeTasksRecoveryResult({ results: [] })).toEqual({ results: [] });
    expect(normalizeTasksRecoveryResult({ results: [{ taskId: "task-1" }] })).toBeNull();
  });

  it("uses the protocol schema while preserving the required UI task id", () => {
    const wireTask = {
      id: " task-1 ",
      status: "running",
      runtime: "future-runtime",
      runId: "run-1",
      flowId: "flow-1",
      parentTaskId: "parent-1",
      sourceId: "source-1",
    };

    expect(normalizeTasksListResult({ tasks: [wireTask] })?.[0]).toEqual({
      ...wireTask,
      id: "task-1",
      taskId: "task-1",
    });
    expect(normalizeTasksGetResult({ task: wireTask })?.taskId).toBe("task-1");
    expect(normalizeTasksListResult({ tasks: [{ ...wireTask, updatedAt: false }] })).toBeNull();
  });

  it("merges upserts, applies deletes, and requests refetches for restored events", () => {
    const initial = [task({ id: "task-1", status: "running", updatedAt: 100 })];
    const completed = task({ id: "task-1", status: "completed", updatedAt: 200 });

    const upserted = applyTaskEvent(initial, { action: "upserted", task: completed });
    expect(upserted).toEqual({ tasks: [completed], refetch: false });

    const deleted = applyTaskEvent(upserted.tasks, { action: "deleted", taskId: "task-1" });
    expect(deleted).toEqual({ tasks: [], refetch: false });
    expect(applyTaskEvent(initial, { action: "restored" })).toEqual({
      tasks: initial,
      refetch: true,
    });
    expect(applyTaskEvent(initial, { action: "upserted", task: { id: "broken" } })).toEqual({
      tasks: initial,
      refetch: true,
    });
  });

  it.each([100, 200])(
    "does not resurrect a completed task from a running event timestamped %i",
    (updatedAt) => {
      const completed = task({ id: "task-1", status: "completed", updatedAt: 200 });
      const staleRunning = task({ id: "task-1", status: "running", updatedAt });

      expect(applyTaskEvent([completed], { action: "upserted", task: staleRunning })).toEqual({
        tasks: [completed],
        refetch: false,
      });
    },
  );

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "does not replace an equally recent %s event with running work",
    (status) => {
      const terminal = task({ id: "task-1", status, updatedAt: 200 });
      const running = task({ id: "task-1", status: "running", updatedAt: 200 });

      expect(applyTaskEvent([terminal], { action: "upserted", task: running })).toEqual({
        tasks: [terminal],
        refetch: false,
      });
      expect(applyTaskEvent([running], { action: "upserted", task: terminal })).toEqual({
        tasks: [terminal],
        refetch: false,
      });
    },
  );

  it.each(["completed", "failed", "cancelled", "timed_out"] as const)(
    "accepts an authoritative equally recent %s terminal event correction",
    (status) => {
      const current = task({
        id: "task-1",
        status,
        updatedAt: 200,
        terminalSummary: "Previous terminal details",
      });
      const correction = task({
        id: "task-1",
        status,
        updatedAt: 200,
        terminalSummary: "Authoritative terminal details",
      });

      expect(applyTaskEvent([current], { action: "upserted", task: correction })).toEqual({
        tasks: [correction],
        refetch: false,
      });
    },
  );

  it("advances a queued task when its running event shares the timestamp", () => {
    const queued = task({ id: "task-1", status: "queued", updatedAt: 200 });
    const running = task({ id: "task-1", status: "running", updatedAt: 200 });

    expect(applyTaskEvent([queued], { action: "upserted", task: running })).toEqual({
      tasks: [running],
      refetch: false,
    });
  });

  it("applies incoming running tool progress at the same timestamp", () => {
    const previous = task({
      id: "task-1",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
    });
    const progress = task({
      id: "task-1",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
    });

    expect(applyTaskEvent([previous], { action: "upserted", task: progress })).toEqual({
      tasks: [progress],
      refetch: false,
    });
  });

  it("does not regress running tool progress from an equally recent stale event", () => {
    const progress = task({
      id: "task-1",
      status: "running",
      updatedAt: 200,
      toolUseCount: 2,
      lastToolName: "write",
    });
    const stale = task({
      id: "task-1",
      status: "running",
      updatedAt: 200,
      toolUseCount: 1,
      lastToolName: "read",
    });

    expect(applyTaskEvent([progress], { action: "upserted", task: stale })).toEqual({
      tasks: [progress],
      refetch: false,
    });
  });

  it("deletes only the requested task after applying task progress", () => {
    const completed = task({ id: "completed", status: "completed", updatedAt: 200 });
    const running = task({ id: "running", status: "running", updatedAt: 200 });

    expect(
      applyTaskEvent([completed, running], { action: "deleted", taskId: "completed" }),
    ).toEqual({
      tasks: [running],
      refetch: false,
    });
  });

  it("applies a genuinely newer running task event", () => {
    const oldRunning = task({ id: "task-1", status: "running", updatedAt: 100 });
    const newRunning = task({ id: "task-1", status: "running", updatedAt: 200 });

    expect(applyTaskEvent([oldRunning], { action: "upserted", task: newRunning })).toEqual({
      tasks: [newRunning],
      refetch: false,
    });
  });
});
