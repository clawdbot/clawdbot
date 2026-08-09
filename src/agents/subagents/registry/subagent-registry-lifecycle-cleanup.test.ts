import { describe, expect, it, vi } from "vitest";
import { removeSubagentAttachmentsForCleanup } from "./subagent-registry-lifecycle-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("removeSubagentAttachmentsForCleanup", () => {
  const entry = { runId: "run-1" } as SubagentRunRecord;

  it("accepts completed cleanup", async () => {
    const remove = vi.fn(async () => true);

    await expect(removeSubagentAttachmentsForCleanup(entry, remove)).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith(entry);
  });

  it("rejects cleanup that would strand its registry owner", async () => {
    const remove = vi.fn(async () => false);

    await expect(removeSubagentAttachmentsForCleanup(entry, remove)).rejects.toThrow(
      "retaining registry owner for retry",
    );
  });
});
