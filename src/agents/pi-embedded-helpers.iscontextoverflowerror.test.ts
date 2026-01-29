import { describe, expect, it } from "vitest";
import { isContextOverflowError } from "./pi-embedded-helpers.js";

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "prompt is too long: 208423 tokens > 200000 maximum",
      "Context overflow: Summarization failed",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches Anthropic 'Request size exceeds model context window' error", () => {
    // Anthropic returns this error format when the prompt exceeds the context window.
    // Without this fix, auto-compaction is NOT triggered because neither
    // isContextOverflowError nor pi-ai's isContextOverflow recognizes this pattern.
    // The user sees: "LLM request rejected: Request size exceeds model context window"
    // instead of automatic compaction + retry.
    const anthropicRawError =
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}';
    expect(isContextOverflowError(anthropicRawError)).toBe(true);
  });

  it("matches 'exceeds model context window' in various formats", () => {
    const samples = [
      "Request size exceeds model context window",
      "request size exceeds model context window",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      "The request size exceeds model context window limit",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("matches 'context_overflow' with underscore format", () => {
    // Issue #3154: Some providers return "context_overflow" (underscore) instead of
    // "context overflow" (space). Without this fix, auto-compaction is NOT triggered.
    // The user sees the error instead of automatic compaction + retry.
    const samples = [
      "context_overflow: prompt too large for the model",
      "Context_Overflow: request exceeds limit",
      "ERROR: context_overflow detected",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
    expect(isContextOverflowError("request size exceeds upload limit")).toBe(false);
    expect(isContextOverflowError("model not found")).toBe(false);
    expect(isContextOverflowError("authentication failed")).toBe(false);
  });
});
