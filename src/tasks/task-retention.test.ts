// Covers task retention pruning and stale-task cleanup windows.
import { describe, expect, it } from "vitest";
import { resolveEffectiveTaskCleanupAfter, resolveTaskCleanupAfter } from "./task-retention.js";

const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;

describe("task retention", () => {
  it("keeps lost tasks on a shorter retention window", () => {
    expect(
      resolveTaskCleanupAfter({
        status: "lost",
        createdAt: 10,
      }),
    ).toBe(10 + LOST_TASK_RETENTION_MS);
    expect(
      resolveTaskCleanupAfter({
        status: "failed",
        createdAt: 10,
      }),
    ).toBe(10 + DEFAULT_TASK_RETENTION_MS);
  });

  it("stamps cleanupAfter from terminal task timing", () => {
    expect(
      resolveTaskCleanupAfter({
        status: "lost",
        createdAt: 1,
        lastEventAt: 2,
        endedAt: 3,
      }),
    ).toBe(3 + LOST_TASK_RETENTION_MS);
  });

  it("clamps old lost cleanupAfter values to the shorter retention window", () => {
    expect(
      resolveEffectiveTaskCleanupAfter({
        status: "lost",
        createdAt: 1,
        endedAt: 10,
        cleanupAfter: 10 + DEFAULT_TASK_RETENTION_MS,
      }),
    ).toBe(10 + LOST_TASK_RETENTION_MS);
  });

  it("preserves explicit cleanupAfter for non-lost terminal tasks", () => {
    expect(
      resolveEffectiveTaskCleanupAfter({
        status: "failed",
        createdAt: 1,
        endedAt: 10,
        cleanupAfter: 99,
      }),
    ).toBe(99);
  });
});
