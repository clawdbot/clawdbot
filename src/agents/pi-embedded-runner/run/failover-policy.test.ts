import { describe, expect, it } from "vitest";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";

describe("resolveRunFailoverDecision", () => {
  it("escalates retry-limit exhaustion for replay-safe failover reasons", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: "rate_limit",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("keeps retry-limit as a local error for non-escalating reasons", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: "timeout",
      }),
    ).toEqual({
      action: "return_error_payload",
    });
  });

  it("prefers prompt-side profile rotation before fallback", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "rate_limit",
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("falls back after prompt rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "rate_limit",
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("treats classified assistant-side 429s as rotation candidates even without error stopReason", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: "rate_limit",
        timedOut: false,
        timedOutDuringCompaction: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("falls back after assistant rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: "rate_limit",
        timedOut: false,
        timedOutDuringCompaction: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("does nothing for assistant turns without failover signals", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: false,
        timedOutDuringCompaction: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("does not model-fallback prompt failures after an external abort", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: true,
        externalAbort: true,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("does not rotate or fallback assistant timeouts after an external abort", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: true,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        timedOutDuringCompaction: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });
});

describe("mergeRetryFailoverReason", () => {
  it("preserves the previous classified reason when the current one is null", () => {
    expect(
      mergeRetryFailoverReason({
        previous: "rate_limit",
        failoverReason: null,
      }),
    ).toBe("rate_limit");
  });

  it("records timeout when no classified reason is present", () => {
    expect(
      mergeRetryFailoverReason({
        previous: null,
        failoverReason: null,
        timedOut: true,
      }),
    ).toBe("timeout");
  });
});
