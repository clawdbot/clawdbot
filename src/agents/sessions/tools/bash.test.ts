import { describe, expect, it } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../../../shared/number-coercion.js";
import { resolveBashTimeoutMs } from "./bash.js";

describe("bash tool timeout helpers", () => {
  it("converts positive timeout seconds to timer-safe milliseconds", () => {
    expect(resolveBashTimeoutMs(1)).toBe(1_000);
    expect(resolveBashTimeoutMs(1.5)).toBe(1_500);
    expect(resolveBashTimeoutMs(0.0005)).toBe(1);
  });

  it("caps oversized timeout seconds", () => {
    expect(resolveBashTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("ignores absent, invalid, and non-positive timeout seconds", () => {
    expect(resolveBashTimeoutMs(undefined)).toBeUndefined();
    expect(resolveBashTimeoutMs(Number.NaN)).toBeUndefined();
    expect(resolveBashTimeoutMs(0)).toBeUndefined();
    expect(resolveBashTimeoutMs(-1)).toBeUndefined();
  });
});
