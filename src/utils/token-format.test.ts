import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./token-format.js";

describe("formatTokenCount", () => {
  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(999_500)).toBe("1.0m");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats token counts at exact boundaries", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(10000)).toBe("10k");
    expect(formatTokenCount(50000)).toBe("50k");
    expect(formatTokenCount(1_000_000)).toBe("1.0m");
    expect(formatTokenCount(1_500_000)).toBe("1.5m");
    expect(formatTokenCount(10_000_000)).toBe("10.0m");
  });

  it("returns 0 for invalid and non-positive token counts", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-100)).toBe("0");
    expect(formatTokenCount(undefined)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatTokenCount(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("rounds thousands overflow to millions at the boundary", () => {
    expect(formatTokenCount(999_999)).toBe("1.0m");
    expect(formatTokenCount(9_999)).toBe("10.0k");
  });
});
