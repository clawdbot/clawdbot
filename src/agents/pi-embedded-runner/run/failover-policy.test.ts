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

  it("surfaces deterministic prompt format failures instead of rotating or falling back", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "format",
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "format",
    });
  });

  it("can still rotate explicitly retryable prompt format failures", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        allowFormatRetry: true,
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "format",
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "format",
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
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("surfaces deterministic assistant format failures instead of rotating or falling back", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "format",
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "format",
    });
  });

  it("can still rotate explicitly retryable assistant format failures", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        allowFormatRetry: true,
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "format",
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "format",
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
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
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
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
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

  it("does not rotate or fallback assistant timeouts that fired during tool execution (#52147)", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("does not fallback assistant tool-execution timeouts even after profile rotation exhausted (#52147)", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("still rotates assistant timeouts that fired during LLM phase (no active tool execution)", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: null,
    });
  });

  it("treats idle watchdog timeouts during tool execution as model silence", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: null,
    });
  });

  it("falls back after idle watchdog timeout during tool execution exhausts profile rotation", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: true,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
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
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });

  it("rotates profile on LLM idle timeout before falling back", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: false,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: null,
    });
  });

  it("escalates LLM idle timeout to fallback_model after profile rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: false,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
    });
  });

  it("surfaces error on LLM idle timeout when no fallback is configured and rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: false,
        failoverFailure: false,
        failoverReason: null,
        timedOut: false,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });

  it("does not escalate LLM idle timeout after an external abort", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: true,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: null,
        timedOut: false,
        idleTimedOut: true,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
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
