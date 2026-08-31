import { describe, expect, it } from "vitest";
import { formatWorkspaceConflictSummary } from "./workspace-conflicts.js";

describe("workspace conflict reporting", () => {
  it("counts paths omitted by the projection byte budget", () => {
    expect(
      formatWorkspaceConflictSummary(
        Array.from({ length: 8 }, (_, index) => `very-long-${index}.txt`),
        "refs/openclaw/worker-results/claim-1",
        30,
      ),
    ).toContain("(+22 more)");
  });
});
