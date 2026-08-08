import { describe, expect, it } from "vitest";
import {
  compactionFailureFromFailoverReason,
  failoverReasonFromCompactionFailure,
  isStructuredCompactionFailure,
  terminalCompactionFailure,
} from "./compaction-failure.js";

describe("compaction failure policy", () => {
  it.each(["empty_response", "overloaded", "rate_limit", "server_error", "timeout"] as const)(
    "classifies %s as retryable",
    (reason) => {
      const failure = compactionFailureFromFailoverReason(reason, 429);

      expect(failure).toEqual({ disposition: "retryable", reason, status: 429 });
      expect(isStructuredCompactionFailure(failure)).toBe(true);
      expect(failoverReasonFromCompactionFailure(failure)).toBe(reason);
    },
  );

  it.each([
    "auth",
    "auth_permanent",
    "billing",
    "context_overflow",
    "format",
    "model_not_found",
    "no_error_details",
    "session_expired",
    "tls_certificate",
    "unclassified",
    "unknown",
  ] as const)("classifies %s as terminal", (reason) => {
    const failure = compactionFailureFromFailoverReason(reason, 401);

    expect(failure).toEqual({ disposition: "terminal", reason, status: 401 });
    expect(isStructuredCompactionFailure(failure)).toBe(true);
    expect(failoverReasonFromCompactionFailure(failure)).toBe(reason);
  });

  it("fails closed for missing or unsupported failure identities", () => {
    expect(compactionFailureFromFailoverReason(undefined)).toEqual({
      disposition: "terminal",
      reason: "unknown",
    });
    expect(isStructuredCompactionFailure({ disposition: "retryable", reason: "auth" })).toBe(false);
    expect(isStructuredCompactionFailure({ reason: "rate_limit" })).toBe(false);
  });

  it.each([
    { disposition: "retryable", reason: "rate_limit", status: "429" },
    { disposition: "retryable", reason: "rate_limit", status: 99 },
    { disposition: "retryable", reason: "rate_limit", rawError: "provider detail" },
    { disposition: "retryable", reason: "rate_limit", code: "rate_limit_exceeded" },
  ])("fails closed for malformed or legacy retryable envelopes: %j", (failure) => {
    expect(isStructuredCompactionFailure(failure)).toBe(false);
  });

  it("normalizes status values without retaining raw provider errors", () => {
    expect(compactionFailureFromFailoverReason("timeout", 599)).toEqual({
      disposition: "retryable",
      reason: "timeout",
      status: 599,
    });
    expect(terminalCompactionFailure("billing", 99)).toEqual({
      disposition: "terminal",
      reason: "billing",
    });
  });

  it("maps compaction-only terminal reasons to unknown failover identity", () => {
    const failure = terminalCompactionFailure("summary_rejected");

    expect(isStructuredCompactionFailure(failure)).toBe(true);
    expect(failoverReasonFromCompactionFailure(failure)).toBe("unknown");
  });
});
