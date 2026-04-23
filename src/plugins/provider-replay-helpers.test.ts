import { describe, expect, it } from "vitest";
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildHybridAnthropicOrOpenAIReplayPolicy,
  buildNativeAnthropicReplayPolicyForModel,
  buildOpenAICompatibleReplayPolicy,
  buildPassthroughGeminiSanitizingReplayPolicy,
  resolveTaggedReasoningOutputMode,
  sanitizeGoogleGeminiReplayHistory,
  buildStrictAnthropicReplayPolicy,
} from "./provider-replay-helpers.js";

describe("provider replay helpers", () => {
  it("builds strict openai-completions replay policy", () => {
    expect(buildOpenAICompatibleReplayPolicy("openai-completions")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
  });

  it("omits tool-call id sanitization when opted out for openai-completions", () => {
    const policy = buildOpenAICompatibleReplayPolicy("openai-completions", {
      sanitizeToolCallIds: false,
    });
    expect(policy).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("omits tool-call id sanitization when opted out for openai-responses", () => {
    const policy = buildOpenAICompatibleReplayPolicy("openai-responses", {
      sanitizeToolCallIds: false,
    });
    expect(policy).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("builds strict anthropic replay policy", () => {
    expect(buildStrictAnthropicReplayPolicy({ dropThinkingBlocks: true })).toMatchObject({
      sanitizeMode: "full",
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      allowSyntheticToolResults: true,
      dropThinkingBlocks: true,
    });
  });

  it("derives claude-only anthropic replay policy from the model id", () => {
    // Sonnet 4.6 preserves thinking blocks (no drop)
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
    });
    expect(buildAnthropicReplayPolicyForModel("claude-sonnet-4-6")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
    // Legacy models still drop thinking blocks
    expect(buildAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219")).toMatchObject({
      dropThinkingBlocks: true,
    });
    expect(buildAnthropicReplayPolicyForModel("amazon.nova-pro-v1")).not.toHaveProperty(
      "dropThinkingBlocks",
    );
  });

  it("preserves thinking blocks for Claude Opus 4.5+ and Sonnet 4.5+ models", () => {
    // These models should NOT drop thinking blocks
    for (const modelId of [
      "claude-opus-4-5-20251101",
      "claude-opus-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]) {
      const policy = buildAnthropicReplayPolicyForModel(modelId);
      expect(policy).not.toHaveProperty("dropThinkingBlocks");
    }

    // These legacy models SHOULD drop thinking blocks
    for (const modelId of ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20240620"]) {
      const policy = buildAnthropicReplayPolicyForModel(modelId);
      expect(policy).toMatchObject({ dropThinkingBlocks: true });
    }
  });

  it("builds native Anthropic replay policy with selective tool-call id preservation", () => {
    // Sonnet 4.6 preserves thinking blocks
    const policy46 = buildNativeAnthropicReplayPolicyForModel("claude-sonnet-4-6");
    expect(policy46).toMatchObject({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(policy46).not.toHaveProperty("dropThinkingBlocks");

    // Legacy model drops thinking blocks
    expect(buildNativeAnthropicReplayPolicyForModel("claude-3-7-sonnet-20250219")).toMatchObject({
      dropThinkingBlocks: true,
    });
  });

  it("builds hybrid anthropic or openai replay policy", () => {
    const sonnet46Policy = buildHybridAnthropicOrOpenAIReplayPolicy(
      {
        provider: "minimax",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never,
      { anthropicModelDropThinkingBlocks: true },
    );
    expect(sonnet46Policy).toMatchObject({
      validateAnthropicTurns: true,
    });
    expect(sonnet46Policy).not.toHaveProperty("dropThinkingBlocks");

    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy(
        {
          provider: "minimax",
          modelApi: "anthropic-messages",
          modelId: "claude-3-7-sonnet-20250219",
        } as never,
        { anthropicModelDropThinkingBlocks: true },
      ),
    ).toMatchObject({
      validateAnthropicTurns: true,
      dropThinkingBlocks: true,
    });

    expect(
      buildHybridAnthropicOrOpenAIReplayPolicy({
        provider: "minimax",
        modelApi: "openai-completions",
        modelId: "MiniMax-M2.7",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
    });
  });

  it("builds Gemini replay helpers and tagged reasoning mode", () => {
    expect(buildGoogleGeminiReplayPolicy()).toMatchObject({
      validateGeminiTurns: true,
      allowSyntheticToolResults: true,
    });
    expect(resolveTaggedReasoningOutputMode()).toBe("tagged");
  });

  it("builds passthrough Gemini signature sanitization only when needed", () => {
    expect(buildPassthroughGeminiSanitizingReplayPolicy("gemini-2.5-pro")).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });
    expect(
      buildPassthroughGeminiSanitizingReplayPolicy("anthropic/claude-sonnet-4-6"),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("sanitizes Gemini replay ordering with a bootstrap turn", () => {
    const customEntries: Array<{ customType: string; data: unknown }> = [];

    const result = sanitizeGoogleGeminiReplayHistory({
      provider: "google",
      modelApi: "google-generative-ai",
      modelId: "gemini-3.1-pro-preview",
      sessionId: "session-1",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      sessionState: {
        getCustomEntries: () => customEntries,
        appendCustomEntry: (customType: string, data: unknown) => {
          customEntries.push({ customType, data });
        },
      },
    } as never);

    expect(result[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });
});
