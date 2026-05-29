import { describe, expect, it, vi } from "vitest";
import {
  MAX_SAFE_TIMEOUT_DELAY_MS,
  resolveFiniteTimeoutDelayMs,
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

describe("resolveFiniteTimeoutDelayMs", () => {
  it("uses the fallback for missing or non-finite overrides", () => {
    expect(resolveFiniteTimeoutDelayMs(undefined, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.NaN, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.POSITIVE_INFINITY, 10_000, { minMs: 0 })).toBe(
      10_000,
    );
  });

  it("still clamps finite overrides through safe timer bounds", () => {
    expect(resolveFiniteTimeoutDelayMs(3_000_000_000, 10_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(resolveFiniteTimeoutDelayMs(-5, 10_000, { minMs: 0 })).toBe(0);
  });
});

describe("setSafeTimeout", () => {
  it("arms setTimeout with the clamped delay", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const callback = () => undefined;

    const timer = setSafeTimeout(callback, 3_000_000_000);
    clearTimeout(timer);

    expect(timeoutSpy).toHaveBeenCalledWith(callback, MAX_SAFE_TIMEOUT_DELAY_MS);
    timeoutSpy.mockRestore();
  });
});
