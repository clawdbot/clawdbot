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
      warningText: "w".repeat(80_000),
      aggregateOutputDropped: true,
    });

    const content = result.content[0];
    expect(content).toMatchObject({ type: "text" });
    expect(content?.type === "text" ? content.text : "").toMatch(
      /^\[earlier output was discarded at the retention cap and cannot be recovered\]/,
    );
    expect((result.details as { aggregated?: string }).aggregated).toBe("retained output");
  });
});
