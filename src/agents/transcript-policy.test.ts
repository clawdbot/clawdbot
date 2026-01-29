import { describe, expect, it } from "vitest";

import { resolveTranscriptPolicy } from "./transcript-policy.js";

describe("resolveTranscriptPolicy", () => {
  describe("Anthropic provider (direct)", () => {
    it("enables Claude-specific sanitizers for anthropic provider", () => {
      const policy = resolveTranscriptPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for anthropic-messages API", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "anthropic-messages",
        modelId: "claude-3-opus-20240229",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });
  });

  describe("Claude models via non-Anthropic providers", () => {
    it("enables Claude-specific sanitizers for github-copilot with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "github-copilot",
        modelId: "claude-sonnet-4",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for openrouter with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "anthropic/claude-3.5-sonnet",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for opencode with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "opencode",
        modelId: "claude-3-haiku-20240307",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("enables Claude-specific sanitizers for amazon-bedrock with Claude model", () => {
      const policy = resolveTranscriptPolicy({
        provider: "amazon-bedrock",
        modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });

    it("handles case-insensitive Claude model detection", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "CLAUDE-3-OPUS",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });
  });

  describe("OpenAI short-circuit", () => {
    it("disables Claude-specific sanitizers for OpenAI provider even with Claude in modelId", () => {
      // Edge case: OpenAI provider should short-circuit regardless of modelId
      const policy = resolveTranscriptPolicy({
        provider: "openai",
        modelId: "gpt-4-claude-variant", // hypothetical edge case
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("disables Claude-specific sanitizers for openai-codex provider", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openai-codex",
        modelId: "codex-davinci",
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });
  });

  describe("Google models", () => {
    it("enables repairToolUseResultPairing and allowSyntheticToolResults for Google", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-gemini-cli",
        modelId: "gemini-2.0-flash",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(true);
      expect(policy.validateGeminiTurns).toBe(true);
      expect(policy.applyGoogleTurnOrdering).toBe(true);
    });
  });

  describe("non-Claude models via third-party providers", () => {
    it("does not enable Claude-specific sanitizers for GPT models on openrouter", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "openai/gpt-4-turbo",
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("does not enable Claude-specific sanitizers for Llama models on github-copilot", () => {
      const policy = resolveTranscriptPolicy({
        provider: "github-copilot",
        modelId: "llama-3.1-70b",
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("does not enable Claude sanitizers for Gemini models on openrouter (but enables Gemini-specific)", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "google/gemini-pro",
      });

      // Gemini on openrouter gets special thought signature handling but not Claude sanitizers
      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
      expect(policy.sanitizeThoughtSignatures).toEqual({
        allowBase64Only: true,
        includeCamelCase: true,
      });
    });
  });

  describe("Mistral models", () => {
    it("enables Mistral-specific sanitizers", () => {
      const policy = resolveTranscriptPolicy({
        provider: "mistral",
        modelId: "mistral-large",
      });

      expect(policy.sanitizeToolCallIds).toBe(true);
      expect(policy.toolCallIdMode).toBe("strict9");
      expect(policy.sanitizeMode).toBe("full");
    });

    it("detects Mistral models by modelId hint", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "mistralai/mixtral-8x7b",
      });

      expect(policy.sanitizeToolCallIds).toBe(true);
      expect(policy.toolCallIdMode).toBe("strict9");
    });
  });

  describe("edge cases", () => {
    it("handles null/undefined modelId gracefully", () => {
      const policy = resolveTranscriptPolicy({
        provider: "github-copilot",
        modelId: null,
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("handles empty string modelId gracefully", () => {
      const policy = resolveTranscriptPolicy({
        provider: "openrouter",
        modelId: "",
      });

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });

    it("handles undefined params gracefully", () => {
      const policy = resolveTranscriptPolicy({});

      expect(policy.repairToolUseResultPairing).toBe(false);
      expect(policy.validateAnthropicTurns).toBe(false);
      expect(policy.allowSyntheticToolResults).toBe(false);
    });
  });

  describe("google-antigravity Claude models", () => {
    it("enables antigravity-specific settings for Claude via google-antigravity", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "google-antigravity",
        provider: "google-antigravity",
        modelId: "claude-3-5-sonnet",
      });

      expect(policy.preserveSignatures).toBe(true);
      expect(policy.normalizeAntigravityThinkingBlocks).toBe(true);
      // Also enables Claude-specific sanitizers
      expect(policy.repairToolUseResultPairing).toBe(true);
      expect(policy.validateAnthropicTurns).toBe(true);
      expect(policy.allowSyntheticToolResults).toBe(true);
    });
  });
});
