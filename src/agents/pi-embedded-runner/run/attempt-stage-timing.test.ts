import { describe, expect, it } from "vitest";
import {
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";

describe("embedded run stage timing", () => {
  it("captures stage duration and elapsed time", () => {
    let clock = 10;
    const tracker = createEmbeddedRunStageTracker({ now: () => clock });

    clock = 25;
    tracker.mark("workspace");
    clock = 40;
    tracker.mark("tools");
    clock = 45;

    expect(tracker.snapshot()).toEqual({
      totalMs: 35,
      stages: [
        { name: "workspace", durationMs: 15, elapsedMs: 15 },
        { name: "tools", durationMs: 15, elapsedMs: 30 },
      ],
    });
  });

  it("warns only for very slow stage summaries by default", () => {
    expect(
      shouldWarnEmbeddedRunStageSummary({
        totalMs: 9_999,
        stages: [{ name: "auth", durationMs: 4_999, elapsedMs: 4_999 }],
      }),
    ).toBe(false);
    expect(shouldWarnEmbeddedRunStageSummary({ totalMs: 10_000, stages: [] })).toBe(true);
    expect(
      shouldWarnEmbeddedRunStageSummary({
        totalMs: 10,
        stages: [{ name: "auth", durationMs: 5_000, elapsedMs: 5_000 }],
      }),
    ).toBe(true);
  });

  it("supports custom warning thresholds", () => {
    expect(
      shouldWarnEmbeddedRunStageSummary(
        {
          totalMs: 2_000,
          stages: [{ name: "auth", durationMs: 10, elapsedMs: 10 }],
        },
        { totalThresholdMs: 2_000, stageThresholdMs: 1_000 },
      ),
    ).toBe(true);
  });

  it("formats summaries compactly for logs", () => {
    expect(
      formatEmbeddedRunStageSummary("embedded run startup stages: runId=r1", {
        totalMs: 80,
        stages: [
          { name: "workspace", durationMs: 25, elapsedMs: 25 },
          { name: "tools", durationMs: 55, elapsedMs: 80 },
        ],
      }),
    ).toBe(
      "embedded run startup stages: runId=r1 totalMs=80 stages=workspace:25ms@25ms,tools:55ms@80ms",
    );
  });
});
