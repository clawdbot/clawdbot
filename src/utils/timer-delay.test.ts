import { describe, expect, it, vi } from "vitest";
import {
  MAX_SAFE_TIMEOUT_DELAY_MS,
  resolveSafeTimeoutDelayMs,
  setSafeTimeout,
} from "./timer-delay.js";

describe("resolveSafeTimeoutDelayMs", () => {
  it("clamps to Node's signed-32-bit timer ceiling", () => {
    expect(resolveSafeTimeoutDelayMs(3_000_000_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("respects custom minimums", () => {
    expect(resolveSafeTimeoutDelayMs(10, { minMs: 250 })).toBe(250);
    expect(resolveSafeTimeoutDelayMs(10, { minMs: 0 })).toBe(10);
  });

  it("falls back to the minimum for non-finite input", () => {
    expect(resolveSafeTimeoutDelayMs(Number.POSITIVE_INFINITY, { minMs: 250 })).toBe(250);
    expect(resolveSafeTimeoutDelayMs(Number.NaN)).toBe(1);
  });
});

describe("setSafeTimeout", () => {
  it("arms setTimeout with the clamped delay", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const timer = setSafeTimeout(() => undefined, 3_000_000_000);
    clearTimeout(timer);

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
    timeoutSpy.mockRestore();
  });
});
