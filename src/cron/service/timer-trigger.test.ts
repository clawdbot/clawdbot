// Retry-decision tests preserve provider classifications before cron message matching.
import { describe, expect, it } from "vitest";
import { resolveTransientCronRetryDecision } from "./timer-trigger.js";

describe("resolveTransientCronRetryDecision", () => {
  it("keeps permanent-looking and transient provider classifications distinct", () => {
    const error = "HTTP 429: all available credits have been exhausted";

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "billing" },
        consecutiveErrors: 1,
      }),
    ).toEqual({
      retryable: false,
      consecutiveErrors: 1,
      reason: "permanent error",
    });

    expect(
      resolveTransientCronRetryDecision({
        error,
        errorClassification: { kind: "reason", reason: "rate_limit" },
        consecutiveErrors: 1,
      }),
    ).toMatchObject({
      retryable: true,
      consecutiveErrors: 1,
      retryCategory: "rate_limit",
      reason: "transient retry",
    });
  });
});
