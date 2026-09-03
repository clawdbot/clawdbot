import { describe, expect, it } from "vitest";
import { summarizeUpdateRunResponse } from "./update-run-summary.js";

describe("summarizeUpdateRunResponse", () => {
  it("keeps bounded update diagnostics valid at UTF-16 boundaries", () => {
    const reasonPrefix = "r".repeat(239);
    const namePrefix = "n".repeat(99);
    const stderrTail = "s".repeat(499);

    const summary = summarizeUpdateRunResponse({
      ok: false,
      result: {
        status: "error",
        reason: `${reasonPrefix}🤖`,
        steps: [
          {
            name: `${namePrefix}🤖`,
            exitCode: 1,
            stderrTail: `🤖${stderrTail}`,
          },
        ],
      },
    });

    expect(summary.reason).toBe(reasonPrefix);
    expect(summary.failedSteps).toEqual([
      {
        name: namePrefix,
        exitCode: 1,
        stderrTail,
      },
    ]);
  });
});
