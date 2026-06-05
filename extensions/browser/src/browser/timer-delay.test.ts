// Browser tests cover timer delay plugin behavior.
import { describe, expect, it } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS, normalizeBrowserTimerDelayMs } from "./timer-delay.js";

describe("normalizeBrowserTimerDelayMs", () => {
  it("caps timers to Node's safe delay range", () => {
    expect(normalizeBrowserTimerDelayMs(3_000_000_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("preserves positive integer timers and applies the minimum", () => {
    expect(normalizeBrowserTimerDelayMs(1234.9)).toBe(1234);
    expect(normalizeBrowserTimerDelayMs(-5)).toBe(1);
    expect(normalizeBrowserTimerDelayMs(0, { minMs: 0 })).toBe(0);
  });
});
