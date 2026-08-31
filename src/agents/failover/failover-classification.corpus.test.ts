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

import { resolveReplyFailoverFacts } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import {
  classifyFailoverSignal,
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./classify.js";
import { failoverClassificationCorpus } from "./failover-classification.corpus.cases.test-support.js";
import { classifyProviderRequestFacets } from "./request-error-facets.js";
import type { FailoverSignal } from "./signal.js";

afterEach(() => {
  providerRuntimeMocks.classifyProviderFailoverSignalWithPlugin.mockClear();
});

import { renderRateLimitOrOverloadedCopy } from "./user-copy.js";

function classifyReplyRequest(signal: FailoverSignal) {
  return resolveReplyFailoverFacts(signal, signal.message ?? "").providerRequestError;
}

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
    ["Ollama setup pull", "Failed to download gemma4:e2b: pull stream ended before success"],
    ["OpenRouter music", "OpenRouter music generation stream ended before completion"],
    ["MiniMax TTS", "MiniMax music generation stream ended without completion"],
    ["local SSE reader", "SSE stream ended before next event"],
    ["OpenCode Go", "opencode-go stream ended without a terminal event"],
    ["Ollama", "Ollama API stream ended without a final response"],
  ])("does not classify non-assistant %s lifecycle wording", (_source, message) => {
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(classifyFailoverSignal({ message })).toBeNull();
  });

  it("ignores an embedded 429 substring outside a status context", () => {
    const message = "request id req-4291 failed";

    // FIXED(refactor-02): was rate_limit, now null
    expect(isRateLimitErrorMessage(message)).toBe(false);
    expect(classifyFailoverSignal({ message })).toBeNull();
  });

  it("classifies a bare HTTP 503 service-unavailable response as overloaded", () => {
    const message = "503 service unavailable";

    // FIXED(refactor-02): was timeout, now overloaded
    expect(isTimeoutErrorMessage(message)).toBe(false);
    expect(isOverloadedErrorMessage(message)).toBe(true);
    expect(isServerErrorMessage(message)).toBe(false);
    const classification = classifyFailoverSignal({ message });
    expect(classification).toEqual({
      kind: "reason",
      reason: "overloaded",
    });
    const facet = classifyProviderRequestFacets({ message });
    // MOVED(refactor-02): reply layer now consumes the single classifier plus substrate facets.
    expect(facet).toBe("provider-internal-503");
    expect(classifyReplyRequest({ message })).toMatchObject({
      code: "provider_internal_error",
      technicalMessage: message,
      allowTransientHttpRetry: true,
    });
  });

  it("renders rate-limit copy from the classified reason", () => {
    const message = "429 Too Many Requests: model overloaded";

    // FIXED(refactor-02): user copy follows the canonical failover reason.
    expect(classifyFailoverSignal({ message })).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
    expect(renderRateLimitOrOverloadedCopy({ reason: "rate_limit", raw: message })).toBe(
      "⚠️ API rate limit reached. Please try again later.",
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

    const classification = classifyFailoverSignal({ message });
    // MOVED(refactor-02): reply mapping preserves the HTTP-403 copy boundary from typed facts.
    expect(isAuthErrorMessage(message)).toBe(true);
    expect(classification).toEqual({ kind: "reason", reason: "auth" });
    expect(classifyReplyRequest({ message, status: 403 })).toBeUndefined();
  });

  it("preserves quota guidance for generic provider text with HTTP 429 evidence", () => {
    const message = "Something went wrong while processing your request. Please try again.";
    const signal = { message, status: 429 };
    const facet = classifyProviderRequestFacets(signal);

    // MOVED(refactor-02): quota-flavored 429 is a substrate facet, not reply text parsing.
    expect(facet).toBe("quota-429");
    expect(classifyReplyRequest(signal)).toMatchObject({
      code: "provider_rate_limit_or_quota_error",
    });
  });

  it("preserves authentication guidance for provider HTTP 401 failures", () => {
    const message =
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses";
    const signal = { message, status: 401 };
    const classification = classifyFailoverSignal(signal);
    const facet = classifyProviderRequestFacets(signal);

    // MOVED(refactor-02): HTTP status and canonical auth classification select reply copy.
    expect(classification).toEqual({ kind: "reason", reason: "auth" });
    expect(facet).toBeNull();
    expect(classifyReplyRequest(signal)).toMatchObject({ code: "provider_authentication_error" });
  });

  it.each([
    "The AI service returned an internal error. Please try again in a moment.",
    "server_error: An error occurred while processing your request. Please include the request ID req_123.",
  ])("preserves provider-internal guidance for %s", (message) => {
    const facet = classifyProviderRequestFacets({ message });

    // MOVED(refactor-02): provider-internal copy selection now consumes a substrate facet.
    expect(facet).toBe("provider-internal");
    expect(classifyReplyRequest({ message })).toMatchObject({ code: "provider_internal_error" });
  });

  it("preserves model-unavailable guidance from the canonical reason", () => {
    const message = "Unknown model: openai/gpt-5.3-codex";
    const classification = classifyFailoverSignal({ message });
    const facet = classifyProviderRequestFacets({ message });

    // MOVED(refactor-02): model availability copy consumes the canonical typed reason.
    expect(classification).toEqual({ kind: "reason", reason: "model_not_found" });
    expect(facet).toBeNull();
    expect(classifyReplyRequest({ message })).toMatchObject({ code: "provider_model_unavailable" });
  });

  it.each([
    "Custom tool call output is missing for call id: call_live_123.",
    "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
    "400 Function call turn comes immediately after a user turn or after a function response turn.",
    "400 Incorrect role information",
    "messages: roles must alternate between user and assistant",
    "invalid_replay_transcript: OpenAI Responses replay contains dangling_tool_call toolCallId=call_1 at message index 4",
    "messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01A09q90qw90lq917835lq9.",
  ])("preserves conversation-state guidance for %s", (message) => {
    const facet = classifyProviderRequestFacets({ message });

    // MOVED(refactor-02): conversation-state copy selection now consumes a substrate facet.
    expect(facet).toBe("conversation-state");
    expect(classifyReplyRequest({ message })).toMatchObject({
      code: "provider_conversation_state_error",
    });
  });

  it.each([
    {
      message: "ThrottlingException: Rate exceeded",
      rateLimit: true,
    },
    {
      message: "throttling disabled for this account",
      rateLimit: true,
    },
  ])("records generic throttling normalization for $message", (row) => {
    // FIXED(refactor-02): generic matching owns throttling; provider-specific duplicates are gone.
    // "throttling disabled" still matches by decision; it is unrealistic provider error text.
    expect(isRateLimitErrorMessage(row.message)).toBe(row.rateLimit);
    expect(classifyFailoverSignal({ message: row.message })).toEqual({
      kind: "reason",
      reason: "rate_limit",
    });
  });
});
