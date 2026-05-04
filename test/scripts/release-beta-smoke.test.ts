import { describe, expect, it } from "vitest";
import {
  parseWorkflowRunIdFromOutput,
  selectNewestDispatchedRunId,
} from "../../scripts/release-beta-smoke.ts";

describe("release-beta-smoke", () => {
  it("parses workflow run urls when gh includes them in dispatch output", () => {
    expect(
      parseWorkflowRunIdFromOutput(
        "Dispatched: https://github.com/openclaw/openclaw/actions/runs/1234567890",
      ),
    ).toBe("1234567890");
  });

  it("selects the newest workflow_dispatch run not present before dispatch", () => {
    const beforeIds = new Set(["100", "101"]);

    expect(
      selectNewestDispatchedRunId({
        beforeIds,
        runs: [
          { databaseId: 100, createdAt: "2026-05-04T10:00:00Z" },
          { databaseId: 102, createdAt: "2026-05-04T10:01:00Z" },
          { databaseId: 103, createdAt: "2026-05-04T10:02:00Z" },
        ],
      }),
    ).toBe("103");
  });
});
