import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../types.js";
import { isRetryableAssistantError } from "./retry.js";

function errorMessage(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 1,
  };
}

describe("isRetryableAssistantError", () => {
  it.each([
    "An error occurred while processing your request. You can retry your request.",
    "The system encountered an unexpected error. Try your request again.",
    "Temporary provider failure; please retry your request.",
  ])("accepts explicit retry guidance: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it("keeps concrete quota failures non-retryable", () => {
    expect(isRetryableAssistantError(errorMessage("429 insufficient_quota"))).toBe(false);
    expect(isRetryableAssistantError(errorMessage("Monthly usage limit reached"))).toBe(false);
  });

  it.each([
    "model gpt-5.5-preview-0429 not found",
    "model model-x-500-preview not found",
    "Image dimensions 1504x1504 exceed the maximum allowed size",
    "Image width 500 exceeds the maximum allowed size",
    "invalid api key sk-example502value",
  ])("does not retry permanent errors with status-code substrings: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it.each([
    "429 temporary provider response",
    "HTTP 500 temporary provider response",
    "503: temporary provider response",
  ])("retries explicit transient HTTP statuses: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it.each([
    "429 You exceeded your daily request limit. Please try again in 24 hours.",
    "rate limit reached for requests. Retry after 6h.",
    "429 RPM limit exceeded; Retry-After: 2 hours",
    "rate limit reached; Retry-After: 90 minutes",
  ])("does not retry rate limits that outlast session backoff: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it("does not retry a future Retry-After date", () => {
    vi.useFakeTimers();
    const now = new Date("2026-06-11T00:00:00.000Z");
    vi.setSystemTime(now);
    try {
      expect(
        isRetryableAssistantError(
          errorMessage(
            `429 rate limit; Retry-After: ${new Date(now.getTime() + 3_600_000).toUTCString()}`,
          ),
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient billing-service failures", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("503 billing service unavailable; please retry your request"),
      ),
    ).toBe(true);
  });

  it("retries transient subscription-service failures", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("503 subscription service unavailable while checking quota"),
      ),
    ).toBe(true);
  });

  it("retries a 503 with a long Retry-After window", () => {
    expect(
      isRetryableAssistantError(errorMessage("503 Service Unavailable; Retry-After: 120 seconds")),
    ).toBe(true);
  });

  it("retries short-window quota exhaustion", () => {
    expect(
      isRetryableAssistantError(
        errorMessage(
          "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute; please retry your request",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    "OpenAI API error (500): 500 The server had an error while processing your request. Sorry about that!",
    "Azure OpenAI API error (502): Bad gateway from upstream",
    "Mistral API error (503): service temporarily unavailable",
    "Provider API error (504): gateway timeout",
  ])("retries built-in provider-wrapped transient 5xx: %s", (text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(true);
  });

  it("does not treat permanent provider-wrapped 4xx as retryable", () => {
    expect(
      isRetryableAssistantError(
        errorMessage("OpenAI API error (400): 400 Model Id [gpt-5.4-nano] not found"),
      ),
    ).toBe(false);
  });

  it.each([
    ["authentication failure", "OpenAI API error (401): Invalid authentication credentials"],
    [
      "authorization failure",
      "Azure OpenAI API error (403): OAuth authentication is currently not allowed for this organization",
    ],
    ["model not found", "Mistral API error (404): model not found"],
    [
      "quota exhausted",
      "OpenAI API error (429): insufficient_quota: Your account has insufficient quota balance to run this request.",
    ],
    [
      "envelope embedded in user text",
      'Invalid request: user text contained "OpenAI API error (500): invalid input"',
    ],
  ])("does not retry permanent provider-wrapped errors (%s): %s", (_label, text) => {
    expect(isRetryableAssistantError(errorMessage(text))).toBe(false);
  });

  it("retries a provider-wrapped short-window rate limit", () => {
    expect(
      isRetryableAssistantError(
        errorMessage(
          "OpenAI API error (429): RESOURCE_EXHAUSTED: Quota exceeded for requests per minute; please retry your request",
        ),
      ),
    ).toBe(true);
  });
});
