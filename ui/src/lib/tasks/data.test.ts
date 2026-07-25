import { describe, expect, it } from "vitest";
import {
  applyTaskEvent,
  mergeTaskLists,
  normalizeTasksCancelResult,
  partitionTasks,
  sortTasks,
  type TaskSummary,
} from "./data.ts";

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

  it("merges task lists by id with later lists winning", () => {
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
});
