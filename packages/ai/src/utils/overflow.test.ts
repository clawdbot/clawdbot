import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import {
  isConfiguredContextSizeOverflowError,
  isContextOverflow,
  matchesContextOverflowMessage,
} from "./overflow.js";

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

function successfulMessage(
  contextUsage?: AssistantMessage["usage"]["contextUsage"],
): AssistantMessage {
  return {
    ...errorMessage(""),
    usage: {
      input: 12,
      output: 15_104,
      cacheRead: 1_100_000,
      cacheWrite: 93_130,
      ...(contextUsage ? { contextUsage } : {}),
      totalTokens: 1_208_246,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    errorMessage: undefined,
  };
}

describe("configured context size overflow", () => {
  it.each([
    "400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
    "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
  ])("detects %s", (text) => {
    expect(isConfiguredContextSizeOverflowError(text)).toBe(true);
    expect(isContextOverflow(errorMessage(text), 256_000)).toBe(true);
  });
});

describe("provider overflow messages", () => {
  it.each([
    { type: "provider_refusal", overflow: false },
    { type: "provider_fallback", overflow: true },
  ])("preserves $type when the error text mentions overflow", ({ type, overflow }) => {
    const message = errorMessage("prompt is too long: 1200 tokens > 1000 maximum");
    message.diagnostics = [{ type, timestamp: 1 }];
    expect(isContextOverflow(message, 1000)).toBe(overflow);
  });

  it.each([
    "Error: 400 Input length (265330) exceeds model's maximum context length (262144).",
    "Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131,040 tokens.",
    "Input length 131393 exceeds maximum allowed input length of 131040 token",
    "input length and `max_tokens` exceed context limit: 176312 + 32000 > 200000",
    'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 176312 + 32000 > 200000"}}',
    "code 1210: tokens in request more than max tokens allowed",
    "code 1261: Prompt exceeds max length",
  ])("detects %s", (text) => {
    expect(isContextOverflow(errorMessage(text), 262_144)).toBe(true);
  });
});

describe("scoped overflow messages", () => {
  it("recognizes the provider input-length wording in the strict failover scope", () => {
    expect(
      matchesContextOverflowMessage(
        "input length 14295 tokens exceeds the model limit",
        "failover-explicit",
      ),
    ).toBe(true);
  });

  it.each(["too many tokens per day", "token limit exceeded for your billing plan"])(
    "keeps the broad assistant fallback out of strict failover matching: %s",
    (message) => {
      expect(matchesContextOverflowMessage(message, "assistant-error")).toBe(true);
      expect(matchesContextOverflowMessage(message, "failover-explicit")).toBe(false);
    },
  );
});

describe("bodyless HTTP errors", () => {
  it("does not treat an ambiguous 400 as context overflow", () => {
    expect(isContextOverflow(errorMessage("400 status code (no body)"), 262_144)).toBe(false);
  });

  it("preserves Cerebras 413 overflow recovery", () => {
    expect(isContextOverflow(errorMessage("413 status code (no body)"), 262_144)).toBe(true);
  });
});

describe("usage-based overflow", () => {
  it("prefers an available context snapshot over aggregate billing usage", () => {
    expect(
      isContextOverflow(
        successfulMessage({
          state: "available",
          promptTokens: 148_874,
          totalTokens: 163_978,
        }),
        1_000_000,
      ),
    ).toBe(false);
  });

  it("does not infer overflow from aggregate billing when context is unavailable", () => {
    expect(isContextOverflow(successfulMessage({ state: "unavailable" }), 1_000_000)).toBe(false);
  });

  it("counts cache-write tokens toward the context when no snapshot is available", () => {
    // input + cacheRead alone is 1_100_012, under this window; the 93_130 cache-write
    // tokens are prompt tokens too, and providers that report them separately keep
    // them out of `input`. Omitting the bucket silently under-counts the context.
    expect(isContextOverflow(successfulMessage(), 1_150_000)).toBe(true);
  });
});
