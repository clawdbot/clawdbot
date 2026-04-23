import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BY_MODEL_REPLAY_HOOKS,
  buildProviderReplayFamilyHooks,
  NATIVE_ANTHROPIC_REPLAY_HOOKS,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
} from "./provider-model-shared.js";

describe("buildProviderReplayFamilyHooks", () => {
  it("covers the replay family matrix", async () => {
    const cases = [
      {
        family: "openai-compatible" as const,
        ctx: {
          provider: "xai",
          modelApi: "openai-completions",
          modelId: "grok-4",
        },
        match: {
          sanitizeToolCallIds: true,
          applyAssistantFirstOrderingFix: true,
          validateGeminiTurns: true,
        },
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "anthropic-by-model" as const,
        ctx: {
          provider: "anthropic-vertex",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        },
        match: {
          validateAnthropicTurns: true,
          // Sonnet 4.6 preserves thinking blocks (no dropThinkingBlocks)
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "native-anthropic-by-model" as const,
        ctx: {
          provider: "anthropic",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        },
        match: {
          sanitizeMode: "full",
          preserveNativeAnthropicToolUseIds: true,
          preserveSignatures: true,
          repairToolUseResultPairing: true,
          validateAnthropicTurns: true,
          allowSyntheticToolResults: true,
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "google-gemini" as const,
        ctx: {
          provider: "google",
          modelApi: "google-generative-ai",
          modelId: "gemini-3.1-pro-preview",
        },
        match: {
          validateGeminiTurns: true,
          allowSyntheticToolResults: true,
        },
        hasSanitizeReplayHistory: true,
        reasoningMode: "tagged",
      },
      {
        family: "passthrough-gemini" as const,
        ctx: {
          provider: "openrouter",
          modelApi: "openai-completions",
          modelId: "gemini-2.5-pro",
        },
        match: {
          applyAssistantFirstOrderingFix: false,
          validateGeminiTurns: false,
          validateAnthropicTurns: false,
          sanitizeThoughtSignatures: {
            allowBase64Only: true,
            includeCamelCase: true,
          },
        },
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
      {
        family: "hybrid-anthropic-openai" as const,
        options: {
          anthropicModelDropThinkingBlocks: true,
        },
        ctx: {
          provider: "minimax",
          modelApi: "anthropic-messages",
          modelId: "claude-sonnet-4-6",
        },
        match: {
          validateAnthropicTurns: true,
          // Sonnet 4.6 preserves thinking blocks even with flag set
        },
        absent: ["dropThinkingBlocks"],
        hasSanitizeReplayHistory: false,
        reasoningMode: undefined,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderReplayFamilyHooks(
        testCase.options
          ? {
              family: testCase.family,
              ...testCase.options,
            }
          : { family: testCase.family },
      );

      const policy = hooks.buildReplayPolicy?.(testCase.ctx as never);
      expect(policy).toMatchObject(testCase.match);
      if ((testCase as { absent?: string[] }).absent) {
        for (const key of (testCase as { absent: string[] }).absent) {
          expect(policy).not.toHaveProperty(key);
        }
      }
      expect(Boolean(hooks.sanitizeReplayHistory)).toBe(testCase.hasSanitizeReplayHistory);
      expect(hooks.resolveReasoningOutputMode?.(testCase.ctx as never)).toBe(
        testCase.reasoningMode,
      );
    }
  });

  it("keeps google-gemini replay sanitation on the bootstrap path", async () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "google-gemini",
    });

    const sanitized = await hooks.sanitizeReplayHistory?.({
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
        getCustomEntries: () => [],
        appendCustomEntry: () => {},
      },
    } as never);

    expect(sanitized?.[0]).toMatchObject({
      role: "user",
      content: "(session bootstrap)",
    });
  });

  it("keeps anthropic-by-model replay family scoped to claude ids", () => {
    const hooks = buildProviderReplayFamilyHooks({
      family: "anthropic-by-model",
    });

    expect(
      hooks.buildReplayPolicy?.({
        provider: "amazon-bedrock",
        modelApi: "anthropic-messages",
        modelId: "amazon.nova-pro-v1",
      } as never),
    ).not.toHaveProperty("dropThinkingBlocks");
  });

  it("exposes canonical replay hooks for reused provider families", () => {
    expect(
      OPENAI_COMPATIBLE_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "grok-4",
      } as never),
    ).toMatchObject({
      sanitizeToolCallIds: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
    });

    const nativeIdsHooks = buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      sanitizeToolCallIds: false,
    });
    const nativeIdsPolicy = nativeIdsHooks.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);
    expect(nativeIdsPolicy).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(nativeIdsPolicy).not.toHaveProperty("sanitizeToolCallIds");
    expect(nativeIdsPolicy).not.toHaveProperty("toolCallIdMode");

    expect(
      PASSTHROUGH_GEMINI_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
    });

    expect(
      ANTHROPIC_BY_MODEL_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "amazon-bedrock",
        modelApi: "bedrock-converse-stream",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toMatchObject({
      validateAnthropicTurns: true,
      repairToolUseResultPairing: true,
    });

    expect(
      NATIVE_ANTHROPIC_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toMatchObject({
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      validateAnthropicTurns: true,
    });
  });
});
