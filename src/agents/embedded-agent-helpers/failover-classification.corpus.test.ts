// Freezes the central failover classifier before the refactor-02 consolidation.
import { afterEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverReasonWithPlugin: vi.fn(() => null),
  matchesProviderContextOverflowWithPlugin: vi.fn(() => false),
}));

// provider-error-patterns.ts resolves these hooks through a lazy require. Mocking
// the runtime explicitly keeps the corpus independent of plugin loadability.
vi.mock("../../plugins/provider-runtime.js", () => providerRuntimeMocks);

import { classifyProviderRequestError } from "../../auto-reply/reply/provider-request-error-classifier.js";
import { classifyFailoverSignal } from "./errors.js";
import { authFormatCases } from "./failover-classification.auth-format.cases.js";
import { billingCases } from "./failover-classification.billing.cases.js";
import { overflowServerMiscCases } from "./failover-classification.overflow-server-misc.cases.js";
import { overflowCases } from "./failover-classification.overflow.cases.js";
import { rateLimitOverloadCases } from "./failover-classification.rate-limit-overload.cases.js";
import { structuredMiscCases } from "./failover-classification.structured-misc.cases.js";

afterEach(() => {
  providerRuntimeMocks.classifyProviderFailoverReasonWithPlugin.mockClear();
  providerRuntimeMocks.matchesProviderContextOverflowWithPlugin.mockClear();
});

const failoverClassificationCorpus = [
  ...overflowCases,
  ...billingCases,
  ...rateLimitOverloadCases,
  ...overflowServerMiscCases,
  ...authFormatCases,
  ...structuredMiscCases,
];
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./failover-matches.js";
import { classifyProviderSpecificError } from "./provider-error-patterns.js";
import { formatRateLimitOrOverloadedErrorCopy } from "./sanitize-user-facing-text.js";

describe("golden failover classification corpus", () => {
  it("has unique row ids", () => {
    const ids = failoverClassificationCorpus.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not duplicate a signal from the same source", () => {
    const sourceSignals = failoverClassificationCorpus.map(
      (row) => `${row.source}:${JSON.stringify(row.signal)}`,
    );
    expect(new Set(sourceSignals).size).toBe(sourceSignals.length);
  });

  it.each(failoverClassificationCorpus)("$id [$source]", ({ signal, expected }) => {
    expect(classifyFailoverSignal(signal)).toEqual(expected);
  });
});

describe("cross-layer drift (documents current behavior, see refactor-02)", () => {
  it.each(["input length 14295 tokens exceeds the model limit", "request id req-4291 failed"])(
    "treats an embedded 429 substring as rate limiting: %s",
    (message) => {
      // BUG(refactor-02): the bare `429` alternative is not token-boundary-aware.
      expect(isRateLimitErrorMessage(message)).toBe(true);
      expect(classifyFailoverSignal({ message })).toEqual({
        kind: "reason",
        reason: "rate_limit",
      });
    },
  );

  it("disagrees about a bare HTTP 503 across agent and reply classifiers", () => {
    const message = "503 service unavailable";

    // BUG(refactor-02): the agent helpers split one provider failure three ways.
    expect(isTimeoutErrorMessage(message)).toBe(true);
    expect(isOverloadedErrorMessage(message)).toBe(false);
    expect(isServerErrorMessage(message)).toBe(false);
    expect(classifyProviderRequestError(message)).toMatchObject({
      code: "provider_internal_error",
      technicalMessage: message,
      allowTransientHttpRetry: true,
    });
  });

  it("uses rate-limit retry semantics but overloaded user copy", () => {
    const message = "429 Too Many Requests: model overloaded";

    // BUG(refactor-02): retry classification and user-copy precedence are inverted.
    expect(classifyFailoverSignal({ message })).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
    expect(formatRateLimitOrOverloadedErrorCopy(message)).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });

  it("drops billing classification at the 512-character gate", () => {
    const longMessage = JSON.stringify({
      error: {
        message: "insufficient credits",
        type: "account_balance_error",
        details: "x".repeat(600),
      },
    });
    const truncatedMessage = longMessage.slice(0, 511);

    // BUG(refactor-02): realistic long JSON loses soft billing evidence.
    expect(longMessage.length).toBeGreaterThan(512);
    expect(truncatedMessage.length).toBeLessThan(512);
    expect(isBillingErrorMessage(longMessage)).toBe(false);
    expect(isBillingErrorMessage(truncatedMessage)).toBe(true);
  });

  it("rotates ambiguous 403 permissions without reply-level auth copy", () => {
    const message = "403 Forbidden: insufficient permissions";

    // BUG(refactor-02): failover and reply classifiers expose different auth lanes.
    expect(isAuthErrorMessage(message)).toBe(true);
    expect(classifyProviderRequestError(message)).toBeUndefined();
  });

  it.each([
    {
      message: "ThrottlingException: Rate exceeded",
      rateLimit: true,
      providerSpecific: "rate_limit" as const,
    },
    {
      message: "throttling disabled for this account",
      rateLimit: true,
      providerSpecific: null,
    },
  ])("records throttling normalization spread for $message", (row) => {
    // BUG(refactor-02): generic substring matching is broader than provider patterns.
    expect(isRateLimitErrorMessage(row.message)).toBe(row.rateLimit);
    expect(classifyProviderSpecificError(row.message, { includePluginHooks: false })).toBe(
      row.providerSpecific,
    );
  });
});
