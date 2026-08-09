import { describe, expect, it, vi } from "vitest";
import { retireSupersededSubagentRun } from "./subagent-registry-sweeper-retire.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const helperMocks = vi.hoisted(() => ({
  safeRemoveAttachmentsDir: vi.fn(async () => false),
}));

vi.mock("./subagent-registry-helpers.js", () => ({
  safeRemoveAttachmentsDir: helperMocks.safeRemoveAttachmentsDir,
}));

describe("retireSupersededSubagentRun", () => {
  it("retains the durable row when attachment cleanup fails", async () => {
    const entry = {
      runId: "run-1",
      cleanup: "delete",
      execution: { status: "terminal" },
    } as SubagentRunRecord;
    const runs = new Map([[entry.runId, entry]]);
    const persistOrThrow = vi.fn();

    await expect(
      retireSupersededSubagentRun({
        runId: entry.runId,
        entry,
        runs,
        clearPendingLifecycleError: vi.fn(),
        persistOrThrow,
      }),
    ).rejects.toThrow("retaining superseded registry owner");

    expect(runs.get(entry.runId)).toBe(entry);
    expect(persistOrThrow).not.toHaveBeenCalled();
  });
});
