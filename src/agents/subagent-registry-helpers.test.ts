import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileOrphanedRun } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves timing on orphaned error outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-id",
        source: "resume",
        runs,
        resumedRuns,
      }),
    ).toBe(true);

    expect(entry.endedAt).toBe(4_000);
    expect(entry.outcome).toEqual({
      status: "error",
      error: "orphaned subagent run (missing-session-id)",
      startedAt: 1_000,
      endedAt: 4_000,
      elapsedMs: 3_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
    expect(resumedRuns.has(entry.runId)).toBe(false);
  });
});
