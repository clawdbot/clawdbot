import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BY_MODEL_REPLAY_HOOKS,
  buildProviderReplayFamilyHooks,
  NATIVE_ANTHROPIC_REPLAY_HOOKS,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
  resolveClaudeThinkingProfile,
} from "./provider-model-shared.js";

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readLevelIds(profile: unknown): string[] {
  const levels = (profile as { levels?: Array<{ id?: unknown }> } | undefined)?.levels;
  expect(Array.isArray(levels)).toBe(true);
  return (levels ?? []).map((level) => String(level.id));
}

function expectLevelIdsInclude(profile: unknown, expectedIds: readonly string[]): void {
  const ids = readLevelIds(profile);
  for (const id of expectedIds) {
    expect(ids.includes(id), `level ${id}`).toBe(true);
  }
}

describe("buildProviderReplayFamilyHooks", () => {
  it("covers the replay family matrix", () => {
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
          dropReasoningFromHistory: true,
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
      expectFields(policy, testCase.match);
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

    expectFields(sanitized?.[0], {
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
    expectFields(
      OPENAI_COMPATIBLE_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "xai",
        modelApi: "openai-completions",
        modelId: "google/gemma-4-26b-a4b-it",
      } as never),
      {
        sanitizeToolCallIds: true,
        applyAssistantFirstOrderingFix: true,
        validateGeminiTurns: true,
        dropReasoningFromHistory: true,
      },
    );

    const nativeIdsHooks = buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      sanitizeToolCallIds: false,
      dropReasoningFromHistory: false,
    });
    const nativeIdsPolicy = nativeIdsHooks.buildReplayPolicy?.({
      provider: "moonshot",
      modelApi: "openai-completions",
      modelId: "kimi-k2.6",
    } as never);
    expectFields(nativeIdsPolicy, {
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(nativeIdsPolicy).not.toHaveProperty("sanitizeToolCallIds");
    expect(nativeIdsPolicy).not.toHaveProperty("toolCallIdMode");

    expectFields(
      PASSTHROUGH_GEMINI_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
      } as never),
      {
        applyAssistantFirstOrderingFix: false,
        validateGeminiTurns: false,
        validateAnthropicTurns: false,
        sanitizeThoughtSignatures: {
          allowBase64Only: true,
          includeCamelCase: true,
        },
      },
    );

    expectFields(
      ANTHROPIC_BY_MODEL_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "amazon-bedrock",
        modelApi: "bedrock-converse-stream",
        modelId: "claude-sonnet-4-6",
      } as never),
      {
        validateAnthropicTurns: true,
        repairToolUseResultPairing: true,
      },
    );

    expectFields(
      NATIVE_ANTHROPIC_REPLAY_HOOKS.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
      {
        preserveNativeAnthropicToolUseIds: true,
        preserveSignatures: true,
        validateAnthropicTurns: true,
      },
    );
  });
});

describe("resolveClaudeThinkingProfile", () => {
  it("exposes Opus 4.7 thinking levels for direct and proxied Claude providers", () => {
    const directProfile = resolveClaudeThinkingProfile("claude-opus-4-7");
    expectFields(directProfile, {
      defaultLevel: "off",
    });
    expectLevelIdsInclude(directProfile, ["xhigh", "adaptive", "max"]);

    const proxiedProfile = resolveClaudeThinkingProfile("claude-opus-4.7-20260219");
    expectFields(proxiedProfile, {
      defaultLevel: "off",
    });
    expectLevelIdsInclude(proxiedProfile, ["xhigh", "adaptive", "max"]);
  });

  it("keeps adaptive-only Claude variants from advertising xhigh or max", () => {
    const profile = resolveClaudeThinkingProfile("claude-sonnet-4-6");

    expectFields(profile, {
      defaultLevel: "adaptive",
    });
    expectLevelIdsInclude(profile, ["adaptive"]);
    const fixedBudgetLevels = profile.levels.filter(
      (level) => level.id === "xhigh" || level.id === "max",
    );
    expect(fixedBudgetLevels).toStrictEqual([]);
  });
});
