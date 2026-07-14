// Covers task retention pruning and stale-task cleanup windows.
import { describe, expect, it } from "vitest";
import {
  resolveEffectiveTaskCleanupAfter,
  resolveTaskCleanupAfter,
  resolveTaskRetentionMs,
} from "./task-retention.js";

const DEFAULT_TASK_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOST_TASK_RETENTION_MS = 24 * 60 * 60_000;

describe("task retention", () => {
  it("keeps lost tasks on a shorter retention window", () => {
    expect(resolveTaskRetentionMs("lost")).toBe(LOST_TASK_RETENTION_MS);
    expect(resolveTaskRetentionMs("failed")).toBe(DEFAULT_TASK_RETENTION_MS);
  });

  it("stamps cleanupAfter from terminal task timing", () => {
    expect(
      resolveTaskCleanupAfter({
        runtime: "subagent",
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
        runtime: "subagent",
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
        runtime: "subagent",
        status: "failed",
        createdAt: 1,
        endedAt: 10,
        cleanupAfter: 99,
      }),
    ).toBe(99);
  });

  it("does not stamp or honor cleanupAfter for terminal cron history", () => {
    const task = {
      runtime: "cron" as const,
      status: "failed" as const,
      createdAt: 1,
      endedAt: 10,
      cleanupAfter: 99,
    };
    expect(resolveTaskCleanupAfter(task)).toBeUndefined();
    expect(resolveEffectiveTaskCleanupAfter(task)).toBeUndefined();
  });

  it("keeps lost cron tasks on the 24-hour window", () => {
    expect(
      resolveTaskCleanupAfter({
        runtime: "cron",
        status: "lost",
        createdAt: 1,
        endedAt: 10,
      }),
    ).toBe(10 + LOST_TASK_RETENTION_MS);
  });
});
