import { afterEach, describe, expect, it } from "vitest";
import {
  checkContextPressure,
  clearContextPressureState,
  type PressureBand,
  resetContextPressureForTests,
  resolveContextPressureBand,
} from "./context-pressure.js";

afterEach(() => {
  resetContextPressureForTests();
});

describe("resolveContextPressureBand", () => {
  it("returns 0 below all bands", () => {
    expect(resolveContextPressureBand(0.1, 0.25)).toBe(0);
    expect(resolveContextPressureBand(0.24, 0.25)).toBe(0);
  });

  it("returns configured first-threshold and escalation bands", () => {
    expect(resolveContextPressureBand(0.25, 0.25)).toBe(25);
    expect(resolveContextPressureBand(0.8, 0.8)).toBe(80);
    expect(resolveContextPressureBand(0.9, 0.8)).toBe(90);
    expect(resolveContextPressureBand(0.95, 0.8)).toBe(95);
  });

  it("return type is the pressure band type", () => {
    const band: PressureBand = resolveContextPressureBand(0.5, 0.25);
    expect(band).toBe(25);
  });

  it("returns highest crossed band", () => {
    expect(resolveContextPressureBand(0.92, 0.8)).toBe(90);
    expect(resolveContextPressureBand(0.99, 0.8)).toBe(95);
  });

  it("resolves the configured early-warning band below threshold", () => {
    expect(resolveContextPressureBand(0.1, 0.8, 0.3125)).toBe(0);
    expect(resolveContextPressureBand(0.25, 0.8, 0.3125)).toBe(25);
    expect(resolveContextPressureBand(0.25, 0.8, 0)).toBe(0);
  });
});

describe("checkContextPressure", () => {
  const base = {
    sessionKey: "test-session",
    contextWindow: 200_000,
    threshold: 0.8,
  };

  it("returns null below threshold", () => {
    expect(checkContextPressure({ ...base, totalTokens: 100_000 })).toBeNull();
  });

  it("fires early-warning band below threshold when configured", () => {
    const result = checkContextPressure({
      ...base,
      totalTokens: 50_000,
      earlyWarningBand: 0.3125,
    });

    expect(result).toContain("[system:context-pressure]");
    expect(result).toContain("25%");
  });

  it("does not fire below threshold when early-warning band is 0", () => {
    expect(
      checkContextPressure({
        ...base,
        totalTokens: 50_000,
        earlyWarningBand: 0,
      }),
    ).toBeNull();
  });

  it("fires at threshold", () => {
    const result = checkContextPressure({ ...base, totalTokens: 160_000 });
    expect(result).toContain("[system:context-pressure]");
    expect(result).toContain("80%");
  });

  it("deduplicates same band", () => {
    expect(checkContextPressure({ ...base, totalTokens: 162_000 })).not.toBeNull();
    expect(checkContextPressure({ ...base, totalTokens: 164_000 })).toBeNull(); // same band
  });

  it("fires on band escalation", () => {
    expect(checkContextPressure({ ...base, totalTokens: 162_000 })).not.toBeNull(); // 80
    expect(checkContextPressure({ ...base, totalTokens: 182_000 })).not.toBeNull(); // 90
  });

  it("fires again after compaction resets to lower band", () => {
    expect(checkContextPressure({ ...base, totalTokens: 190_000 })).not.toBeNull(); // 95
    clearContextPressureState("test-session");
    // After compaction, lower ratio fires fresh:
    expect(checkContextPressure({ ...base, totalTokens: 60_000, threshold: 0.25 })).not.toBeNull();
  });

  it("post-compaction fires unconditionally regardless of level", () => {
    const result = checkContextPressure({
      ...base,
      totalTokens: 20_000, // only 10% — well below threshold
      postCompaction: true,
    });
    expect(result).not.toBeNull();
    expect(result).toContain("Post-compaction");
    expect(result).toContain("compacted");
  });

  it("returns null for zero context window", () => {
    expect(checkContextPressure({ ...base, contextWindow: 0, totalTokens: 100 })).toBeNull();
  });

  it("fires once when the configured threshold rounds to band 0", () => {
    const lowParams = {
      sessionKey: "low-threshold-session",
      contextWindow: 200_000,
      threshold: 0.004,
      totalTokens: 1_000,
    };

    const first = checkContextPressure(lowParams);
    expect(first).not.toBeNull();
    expect(first).toContain("[system:context-pressure]");
    expect(first).toContain("1%");

    // Second call at same band-0 level: dedup should suppress.
    const second = checkContextPressure(lowParams);
    expect(second).toBeNull();

    // Escalating into a real band still fires.
    const escalated = checkContextPressure({
      ...lowParams,
      totalTokens: 182_000,
    });
    expect(escalated).not.toBeNull();
  });
});

// Urgency text names both `continue_delegate(mode='post-compaction')` and
// `request_compaction(reason='...')` with concrete tool-call shapes. The model
// must know how to preserve state and how to trigger the compaction itself.
describe("checkContextPressure — urgency text names both tool calls", () => {
  const base = {
    sessionKey: "urgency-test-session",
    contextWindow: 200_000,
    threshold: 0.8,
  };

  it("band 95 names continue_delegate(mode='post-compaction') AND request_compaction()", () => {
    const result = checkContextPressure({ ...base, totalTokens: 192_000 });
    expect(result).toContain("continue_delegate(mode='post-compaction'");
    expect(result).toContain("request_compaction(reason=");
    expect(result).toContain("COMPACTION IMMINENT");
    expect(result).toContain("Both are tool calls you can make right now, this turn");
  });

  it("band 90 names continue_delegate(mode='post-compaction') AND request_compaction()", () => {
    const result = checkContextPressure({ ...base, totalTokens: 182_000 });
    expect(result).toContain("continue_delegate(mode='post-compaction'");
    expect(result).toContain("request_compaction(reason=");
    expect(result).toContain("nearly full");
  });

  it("band 80 (threshold) names continue_delegate(mode='post-compaction')", () => {
    const result = checkContextPressure({ ...base, totalTokens: 160_000 });
    expect(result).toContain("continue_delegate(mode='post-compaction'");
    expect(result).toContain("stage working-state");
  });
});
