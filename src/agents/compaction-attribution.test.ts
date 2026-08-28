import { describe, expect, it } from "vitest";
import { normalizeCompactionTrigger } from "./compaction-attribution.js";

describe("normalizeCompactionTrigger", () => {
  it("rewrites legacy threshold triggers to the budget attribution band", () => {
    expect(normalizeCompactionTrigger("threshold")).toBe("budget");
  });

  it("preserves non-empty trigger strings after trimming", () => {
    expect(normalizeCompactionTrigger(" volitional ")).toBe("volitional");
  });

  it("falls back to unknown for absent or blank trigger values", () => {
    expect(normalizeCompactionTrigger(undefined)).toBe("unknown");
    expect(normalizeCompactionTrigger("   ")).toBe("unknown");
  });
});
