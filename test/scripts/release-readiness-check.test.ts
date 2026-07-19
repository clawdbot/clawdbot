import { describe, expect, it } from "vitest";
import { runReleaseReadiness } from "../../scripts/release-readiness-check.mjs";

describe("runReleaseReadiness", () => {
  it("runs independent gates concurrently and retains declared order", async () => {
    const stages = [
      { id: "one", command: "one", args: [] },
      { id: "two", command: "two", args: [] },
      { id: "three", command: "three", args: [] },
    ];
    let active = 0;
    let peak = 0;
    const result = await runReleaseReadiness(stages, {
      concurrency: 2,
      runStage: async (stage: (typeof stages)[number]) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return { id: stage.id, status: "passed", durationMs: 1 };
      },
    });

    expect(peak).toBe(2);
    expect(result.status).toBe("passed");
    expect(result.stages.map((stage) => stage.id)).toEqual(["one", "two", "three"]);
  });

  it("reports the complete gate set when one stage fails", async () => {
    const stages = [
      { id: "good", command: "good", args: [] },
      { id: "bad", command: "bad", args: [] },
    ];
    const result = await runReleaseReadiness(stages, {
      runStage: async (stage: (typeof stages)[number]) => ({
        id: stage.id,
        status: stage.id === "bad" ? "failed" : "passed",
        durationMs: 1,
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.stages).toHaveLength(2);
  });
});
