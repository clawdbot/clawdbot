// Retry hint tests cover user-facing guidance for failed cron retry timing.
import { describe, expect, it } from "vitest";
import { resolveCronExecutionRetryHint } from "./retry-hint.js";

describe("resolveCronExecutionRetryHint", () => {
  it("matches classified transient errors", () => {
    expect(resolveCronExecutionRetryHint("HTTP 529", ["overloaded"])).toEqual({
      retryable: true,
      category: "overloaded",
    });
    expect(resolveCronExecutionRetryHint("429 rate limit exceeded", ["rate_limit"])).toEqual({
      retryable: true,
      category: "rate_limit",
    });
  });

  it("treats common network error codes as network when retryOn only includes network", () => {
    for (const code of [
      "EAI_AGAIN",
      "ENETDOWN",
      "EHOSTUNREACH",
      "EHOSTDOWN",
      "ENETRESET",
      "ENETUNREACH",
      "EPIPE",
    ]) {
      expect(resolveCronExecutionRetryHint(`temporary DNS failure: ${code}`, ["network"])).toEqual({
        retryable: true,
        category: "network",
      });
    }
  });

  it("does not retry permanent errors", () => {
    expect(resolveCronExecutionRetryHint("invalid API key", ["network"])).toEqual({
      retryable: false,
    });
  });
});
