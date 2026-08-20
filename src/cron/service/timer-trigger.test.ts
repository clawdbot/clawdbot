// Retry-decision tests preserve provider classifications before cron message matching.
import { describe, expect, it } from "vitest";
import { resolveTransientCronRetryDecision } from "./timer-trigger.js";

describe("resolveTransientCronRetryDecision", () => {
  it("does not retry permanent failures containing incidental 529 values", () => {
    expect(
      resolveTransientCronRetryDecision({
        error: "process exited with 529 lines of output",
        consecutiveErrors: 1,
      }),
    ).toEqual({
      retryable: false,
      consecutiveErrors: 1,
      reason: "permanent error",
    });

    expect(
      resolveTransientCronRetryDecision({
        error: "HTTP 529",
        consecutiveErrors: 1,
      }),
    ).toMatchObject({
      retryable: true,
      consecutiveErrors: 1,
      retryCategory: "overloaded",
      reason: "transient retry",
    });
  });

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
