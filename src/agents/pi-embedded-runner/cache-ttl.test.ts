import { describe, it, expect } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("returns true for direct Anthropic provider", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-opus-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("Anthropic", "claude-sonnet-4-5")).toBe(true);
  });

  it("returns true for OpenRouter with Anthropic models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-opus-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("OpenRouter", "anthropic/claude-3-opus")).toBe(true);
  });

  it("returns true for LiteLLM with Claude models", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-opus-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("LiteLLM", "Claude-3-Opus")).toBe(true);
  });

  it("returns false for LiteLLM with non-Claude models", () => {
    expect(isCacheTtlEligibleProvider("litellm", "gpt-4")).toBe(false);
    expect(isCacheTtlEligibleProvider("litellm", "gemini-pro")).toBe(false);
    expect(isCacheTtlEligibleProvider("litellm", "llama-3")).toBe(false);
  });

  it("returns false for other providers", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4")).toBe(false);
    expect(isCacheTtlEligibleProvider("google", "gemini-pro")).toBe(false);
  });
});
