// Failover policy tests cover the embedded run decision table for retry,
// profile rotation, fallback model escalation, and user-visible errors.
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "../../embedded-agent-helpers.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";

describe("resolveRunFailoverDecision", () => {
  it("escalates retry-limit exhaustion for replay-safe failover reasons", () => {
    // Retry-limit exhaustion is only a model-fallback signal when the carried
    // reason is known to be safe to replay against a different model.
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

  it("escalates retry-limit for model_not_found when fallback is configured", () => {
    // model_not_found should trigger fallback to configured alternatives
    // when the primary model is decommissioned by the provider.
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: true,
        failoverReason: "model_not_found",
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "model_not_found",
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

  it("returns error payload for model_not_found when no fallback is configured", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "retry_limit",
        fallbackConfigured: false,
        failoverReason: "model_not_found",
      }),
    ).toEqual({
      action: "return_error_payload",
    });
  });

  it("prefers prompt-side profile rotation before fallback", () => {
    // Prompt construction can fail before any model output exists, so rotate
    // the current provider profile before spending the configured fallback.
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

  it("surfaces max-turn prompt failures without profile rotation or model fallback", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverCode: "cli_max_turns",
        failoverFailure: true,
        failoverReason: "unknown",
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "unknown",
    });
  });

  it("surfaces prompt run-budget timeouts instead of model fallback (#60388)", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        promptTimeoutFallbackSafe: true,
        timedOutByRunBudget: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("does not rotate prompt failures after the run budget is exhausted (#60388)", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: true,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "rate_limit",
        timedOutByRunBudget: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
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

  it("ignores stale classified assistant-side 429 text without error stopReason", () => {
    // Classifiers may see old assistant text in the transcript. Without an
    // actual failure signal, stale billing/rate-limit text is not failover.
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
        timedOutByRunBudget: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
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
        failoverFailure: true,
        failoverReason: "rate_limit",
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "rate_limit",
    });
  });

  it("does not fall back on stale classified assistant text after rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: false,
        failoverReason: "billing",
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "continue_normal",
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("falls back for opencode-go provider-owned stalled stream errors after rotation is exhausted", () => {
    const assistantError = {
      role: "assistant" as const,
      api: "openai-completions" as const,
      provider: "opencode-go",
      model: "deepseek-v4-flash",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage: "opencode-go stream timed out after provider-owned SSE boundary stalled",
      content: [],
      timestamp: 0,
    };
    const failoverReason = classifyAssistantFailoverReason(assistantError);

    expect(failoverReason).toBe("timeout");
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: failoverReason !== null,
        failoverReason,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: null,
    });
  });

  it("does not rotate harness-owned assistant timeouts", () => {
    // Harness-owned transports already implement their own retry envelope;
    // core failover should not double-rotate on those synthetic timeouts.
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
        harnessOwnsTransport: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("does not rotate harness-owned assistant errors classified as timeout", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        harnessOwnsTransport: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("rotates concrete assistant failover failures that accompany harness-owned timeouts", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "rate_limit",
        timedOut: true,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        harnessOwnsTransport: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "rotate_profile",
      reason: "rate_limit",
    });
  });

  it("falls back with the concrete assistant failover reason after harness-owned timeout rotation is exhausted", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "assistant",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "billing",
        timedOut: true,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        harnessOwnsTransport: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "billing",
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
    });
  });

  it("does not fallback harness-owned LLM idle timeouts after profile rotation is exhausted", () => {
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
        harnessOwnsTransport: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("surfaces harness-owned prompt timeouts instead of falling back", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
      reason: "timeout",
    });
  });

  it("falls back on fallback-safe harness-owned prompt timeouts", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: true,
        failoverFailure: true,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "fallback_model",
      reason: "timeout",
    });
  });

  it("surfaces fallback-safe harness-owned prompt timeouts when no fallback is configured", () => {
    expect(
      resolveRunFailoverDecision({
        stage: "prompt",
        aborted: false,
        externalAbort: false,
        fallbackConfigured: false,
        failoverFailure: true,
        failoverReason: "timeout",
        harnessOwnsTransport: true,
        promptTimeoutFallbackSafe: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "surface_error",
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
        timedOutByRunBudget: false,
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
        timedOutByRunBudget: false,
        profileRotated: false,
      }),
    ).toEqual({
      action: "surface_error",
      reason: null,
    });
  });

  it("does not rotate or fallback assistant timeouts that exhausted the run budget (#60388)", () => {
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
        timedOutByRunBudget: true,
        profileRotated: false,
      }),
    ).toEqual({
      action: "continue_normal",
    });
  });

  it("does not fallback assistant run-budget timeouts even after profile rotation exhausted (#60388)", () => {
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
        timedOutByRunBudget: true,
        profileRotated: true,
      }),
    ).toEqual({
      action: "continue_normal",
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
