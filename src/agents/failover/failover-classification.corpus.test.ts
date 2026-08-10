// Freezes the central failover classifier before the refactor-02 consolidation.
import { afterEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn(() => null),
}));

// classify.ts resolves this hook through a lazy require. Mocking the runtime
// directly keeps the corpus independent of plugin loadability.
vi.mock("../../logging/node-require.js", () => ({
  resolveNodeRequireFromMeta: () => () => providerRuntimeMocks,
}));

import { classifyProviderRequestError } from "../../auto-reply/reply/provider-request-error-classifier.js";
import {
  classifyFailoverSignal,
  classifyProviderSpecificError,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { authFormatCases } from "./failover-classification.auth-format.cases.js";
import { billingCases } from "./failover-classification.billing.cases.js";
import { legacyBillingACases } from "./failover-classification.legacy-billing-a.cases.js";
import { legacyBillingBCases } from "./failover-classification.legacy-billing-b.cases.js";
import { legacyProviderMatcherCases } from "./failover-classification.legacy-provider-matchers.cases.js";
import { overflowServerMiscCases } from "./failover-classification.overflow-server-misc.cases.js";
import { overflowCases } from "./failover-classification.overflow.cases.js";
import { rateLimitOverloadCases } from "./failover-classification.rate-limit-overload.cases.js";
import { structuredMiscCases } from "./failover-classification.structured-misc.cases.js";

afterEach(() => {
  providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockClear();
});

const failoverClassificationCorpus = [
  ...overflowCases,
  ...billingCases,
  ...rateLimitOverloadCases,
  ...overflowServerMiscCases,
  ...authFormatCases,
  ...structuredMiscCases,
  ...legacyBillingACases,
  ...legacyBillingBCases,
  ...legacyProviderMatcherCases,
];
import { formatRateLimitOrOverloadedErrorCopy } from "../embedded-agent-helpers/sanitize-user-facing-text.js";

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
  it.each([
    // FIXED(refactor-02): was rate_limit, now null
    // FOLLOW-UP(refactor-06): reclaim this wording in the canonical overflow table.
    "input length 14295 tokens exceeds the model limit",
    // FIXED(refactor-02): was rate_limit, now null
    "request id req-4291 failed",
  ])("ignores an embedded 429 substring outside a status context: %s", (message) => {
    expect(isRateLimitErrorMessage(message)).toBe(false);
    expect(classifyFailoverSignal({ message })).toBeNull();
  });

  it("classifies a bare HTTP 503 service-unavailable response as overloaded", () => {
    const message = "503 service unavailable";

    // FIXED(refactor-02): was timeout, now overloaded
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(isOverloadedErrorMessage(message)).toBe(true);
    expect(isServerErrorMessage(message)).toBe(false);
    expect(classifyFailoverSignal({ message })).toEqual({
      kind: "reason",
      reason: "overloaded",
    });
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

  it("classifies billing evidence beyond 512 characters", () => {
    const longMessage = JSON.stringify({
      error: {
        message: "insufficient credits",
        type: "account_balance_error",
        details: "x".repeat(600),
      },
    });
    const truncatedMessage = longMessage.slice(0, 511);

    // FIXED(refactor-02): was false, now true
    expect(longMessage.length).toBeGreaterThan(512);
    expect(truncatedMessage.length).toBeLessThan(512);
    expect(isBillingErrorMessage(longMessage)).toBe(true);
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
      // FIXED(refactor-02): was rate_limit, now null
      providerSpecific: null,
    },
    {
      message: "throttling disabled for this account",
      rateLimit: true,
      providerSpecific: null,
    },
  ])("records generic throttling normalization for $message", (row) => {
    // FIXED(refactor-02): generic matching owns throttling; provider-specific duplicates are gone.
    // "throttling disabled" still matches by decision; it is unrealistic provider error text.
    expect(isRateLimitErrorMessage(row.message)).toBe(row.rateLimit);
    expect(classifyFailoverSignal({ message: row.message })).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
    expect(classifyProviderSpecificError(row.message, { includePluginHooks: false })).toBe(
      row.providerSpecific,
    );
  });
});
