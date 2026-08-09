import { describe, expect, it, vi } from "vitest";
import { discardSuspendedPendingFinalDelivery } from "./subagent-registry-suspended-delivery.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const helperMocks = vi.hoisted(() => ({
  safeRemoveAttachmentsDir: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

describe("discardSuspendedPendingFinalDelivery", () => {
  it("retains suspended state when confined attachment cleanup fails", async () => {
    const entry = {
      runId: "run-1",
      childSessionKey: "agent:main:subagent:one",
      requesterSessionKey: "agent:main:main",
      cleanup: "delete",
      execution: { status: "terminal", endedAt: 1 },
      delivery: { status: "suspended", suspendedAt: 1, suspendedReason: "expiry" },
    } as SubagentRunRecord;
    const snapshot = structuredClone(entry);
    const completeCleanupBookkeeping = vi.fn();
    const warn = vi.fn();

    await discardSuspendedPendingFinalDelivery({
      runId: entry.runId,
      entry,
      now: 2,
      reason: "expired",
      resumedRuns: new Set([entry.runId]),
      clearPendingLifecycleError: vi.fn(),
      clearPendingLifecycleTimeout: vi.fn(),
      completeCleanupBookkeeping,
      shouldEmitEndedHookForRun: vi.fn(() => false),
      emitSubagentEndedHookForRun: vi.fn(async () => undefined),
      warn,
    });

    expect(entry).toEqual(snapshot);
    expect(completeCleanupBookkeeping).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "subagent attachment cleanup failed; retaining suspended delivery owner",
      expect.objectContaining({ runId: entry.runId }),
    );
  });
});
