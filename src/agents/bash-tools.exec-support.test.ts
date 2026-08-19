import { describe, expect, it } from "vitest";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";

describe("exec foreground retention", () => {
  it("discloses output discarded at the aggregate cap", () => {
    const result = buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "retained output",
        timedOut: false,
      },
      aggregateOutputDropped: true,
    });

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("discarded at the retention cap and cannot be recovered"),
    });
    expect((result.details as { aggregated?: string }).aggregated).toBe("retained output");
  });
});
