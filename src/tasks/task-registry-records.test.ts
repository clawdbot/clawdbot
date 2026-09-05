import { describe, expect, it } from "vitest";
import { normalizeTaskTimestamps } from "./task-registry-records.js";
import type { TaskRecord, TaskStatus } from "./task-registry.types.js";

function task(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task-${status}`,
    runtime: "cli",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    task: status,
    status,
    deliveryStatus: "not_applicable",
    notifyPolicy: "done_only",
    createdAt: 100,
    ...overrides,
  };
}

describe("normalizeTaskTimestamps", () => {
  it.each(["succeeded", "failed", "timed_out", "cancelled", "lost"] as const)(
    "materializes %s completion from the latest terminal event",
    (status) => {
      expect(normalizeTaskTimestamps(task(status, { lastEventAt: 250 })).endedAt).toBe(250);
    },
  );

  it("falls back to original creation when a legacy terminal has no event time", () => {
    expect(
      normalizeTaskTimestamps(task("failed", { createdAt: 200, startedAt: 100 })).endedAt,
    ).toBe(200);
  });

  it("does not add an end time to active records", () => {
    expect(normalizeTaskTimestamps(task("running", { lastEventAt: 250 })).endedAt).toBeUndefined();
  });
});
