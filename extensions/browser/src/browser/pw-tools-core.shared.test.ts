import { describe, expect, it } from "vitest";
import { normalizeTimeoutMs } from "./pw-tools-core.shared.js";

describe("pw-tools-core shared timeout normalization", () => {
  it("uses the fallback for non-finite timeout values", () => {
    expect(normalizeTimeoutMs(Number.NaN, 20_000)).toBe(20_000);
    expect(normalizeTimeoutMs(Number.POSITIVE_INFINITY, 20_000)).toBe(20_000);
  });

  it("clamps and floors finite timeout values", () => {
    expect(normalizeTimeoutMs(499, 20_000)).toBe(500);
    expect(normalizeTimeoutMs(1_234.9, 20_000)).toBe(1_234);
    expect(normalizeTimeoutMs(999_999, 20_000)).toBe(120_000);
  });
});
