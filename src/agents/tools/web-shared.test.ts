import { describe, expect, it } from "vitest";
import { MAX_TIMER_TIMEOUT_SECONDS } from "../../shared/number-coercion.js";
import { resolvePositiveTimeoutSeconds, resolveTimeoutSeconds } from "./web-shared.js";

describe("web shared timeout seconds", () => {
  it("caps timeoutSeconds at the shared timer-safe ceiling", () => {
    expect(resolveTimeoutSeconds(Number.MAX_SAFE_INTEGER, 30)).toBe(MAX_TIMER_TIMEOUT_SECONDS);
    expect(resolvePositiveTimeoutSeconds(Number.MAX_SAFE_INTEGER, 30)).toBe(
      MAX_TIMER_TIMEOUT_SECONDS,
    );
  });

  it("preserves fallback and minimum behavior", () => {
    expect(resolveTimeoutSeconds(Number.NaN, 30)).toBe(30);
    expect(resolveTimeoutSeconds(0, 30)).toBe(1);
    expect(resolvePositiveTimeoutSeconds(0, 30)).toBe(30);
    expect(resolvePositiveTimeoutSeconds(1.9, 30)).toBe(1);
  });
});
