import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import {
  isRateLimitAssistantError,
  pickFallbackThinkingLevel,
} from "./pi-embedded-helpers.js";

const asAssistant = (overrides: Partial<AssistantMessage>) =>
  ({
    role: "assistant",
    stopReason: "error",
    ...overrides,
  }) as AssistantMessage;

describe("isRateLimitAssistantError", () => {
  it("detects 429 rate limit payloads", () => {
    const msg = asAssistant({
      errorMessage:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
    });
    expect(isRateLimitAssistantError(msg)).toBe(true);
  });

  it("detects human-readable rate limit messages", () => {
    const msg = asAssistant({
      errorMessage: "Too many requests. Rate limit exceeded.",
    });
    expect(isRateLimitAssistantError(msg)).toBe(true);
  });

  it("detects quota exceeded messages", () => {
    const msg = asAssistant({
      errorMessage:
        "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
    });
    expect(isRateLimitAssistantError(msg)).toBe(true);
  });

  it("returns false for non-error messages", () => {
    const msg = asAssistant({
      stopReason: "end_turn",
      errorMessage: "rate limit",
    });
    expect(isRateLimitAssistantError(msg)).toBe(false);
  });
});

describe("pickFallbackThinkingLevel", () => {
  it("selects the first supported thinking level", () => {
    const attempted = new Set<ThinkLevel>(["low"]);
    const next = pickFallbackThinkingLevel({
      message:
        "Unsupported value: 'low' is not supported with the 'gpt-5.2-pro' model. Supported values are: 'medium', 'high', and 'xhigh'.",
      attempted,
    });
    expect(next).toBe("medium");
  });

  it("skips already attempted levels", () => {
    const attempted = new Set<ThinkLevel>(["low", "medium"]);
    const next = pickFallbackThinkingLevel({
      message: "Supported values are: 'medium', 'high', and 'xhigh'.",
      attempted,
    });
    expect(next).toBe("high");
  });

  it("returns undefined when no supported values are found", () => {
    const attempted = new Set<ThinkLevel>(["low"]);
    const next = pickFallbackThinkingLevel({
      message: "Request failed.",
      attempted,
    });
    expect(next).toBeUndefined();
  });
});
