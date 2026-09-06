import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkboardBoardMetadata, WorkboardBoardSummary } from "./index.js";

describe("workboard board automation contract", () => {
  it("carries the owning automation job reference in metadata and summaries", () => {
    const metadata: WorkboardBoardMetadata = {
      id: "planning",
      automationJobId: "job-categorize-planning",
      createdAt: 1,
      updatedAt: 1,
    };
    const summary: WorkboardBoardSummary = {
      id: metadata.id,
      automationJobId: metadata.automationJobId,
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
    };

    expect(summary.automationJobId).toBe("job-categorize-planning");
    expectTypeOf(summary.automationJobId).toEqualTypeOf<string | undefined>();
  });
});
