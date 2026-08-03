// Qa Lab tests cover timer timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";

describe("qa timer timeout helpers", () => {
  it("adds gateway grace to normal wait timeouts", () => {
    expect(resolveQaGatewayTimeoutWithGraceMs(10_000)).toBe(15_000);
    expect(resolveQaGatewayTimeoutWithGraceMs(10_000, 500)).toBe(10_500);
  });

  it("caps oversized gateway wait timeouts", () => {
    expect(resolveQaGatewayTimeoutWithGraceMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveQaGatewayTimeoutWithGraceMs(MAX_TIMER_TIMEOUT_MS - 100, 500)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("ignores absent or non-positive wait timeouts", () => {
    expect(resolveQaGatewayTimeoutWithGraceMs(undefined)).toBeUndefined();
    expect(resolveQaGatewayTimeoutWithGraceMs(0)).toBeUndefined();
    expect(resolveQaGatewayTimeoutWithGraceMs(-1)).toBeUndefined();
  });
});
