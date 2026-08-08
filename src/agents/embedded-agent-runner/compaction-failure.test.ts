import { describe, expect, it } from "vitest";
import {
  compactionFailureFromFailoverReason,
  fallbackCompactionFailure,
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

  it.each(["missing_thread_binding", "stale_thread_binding"] as const)(
    "classifies %s as synchronous owner fallback",
    (reason) => {
      const failure = fallbackCompactionFailure(reason);

      expect(failure).toEqual({ disposition: "fallback", reason });
      expect(isStructuredCompactionFailure(failure)).toBe(true);
      expect(failoverReasonFromCompactionFailure(failure)).toBe("unknown");
    },
  );

  it.each([
    { disposition: "retryable", reason: "rate_limit", status: "429" },
    { disposition: "retryable", reason: "rate_limit", status: 99 },
    { disposition: "retryable", reason: "rate_limit", rawError: "provider detail" },
    { disposition: "retryable", reason: "rate_limit", code: "rate_limit_exceeded" },
  ])("fails closed for malformed or legacy retryable envelopes: %j", (failure) => {
    expect(isStructuredCompactionFailure(failure)).toBe(false);
  });

  it("rejects inherited, accessor, symbol, and non-enumerable failure fields", () => {
    const inherited = Object.create({ disposition: "retryable", reason: "rate_limit" });
    const accessor = { reason: "rate_limit" };
    Object.defineProperty(accessor, "disposition", {
      enumerable: true,
      get: () => "retryable",
    });
    const symbolField = { disposition: "retryable", reason: "rate_limit", [Symbol()]: true };
    const hiddenLegacyField = { disposition: "retryable", reason: "rate_limit" };
    Object.defineProperty(hiddenLegacyField, "rawError", {
      enumerable: false,
      value: "provider detail",
    });

    expect(isStructuredCompactionFailure(inherited)).toBe(false);
    expect(isStructuredCompactionFailure(accessor)).toBe(false);
    expect(isStructuredCompactionFailure(symbolField)).toBe(false);
    expect(isStructuredCompactionFailure(hiddenLegacyField)).toBe(false);
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
