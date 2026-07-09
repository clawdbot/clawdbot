/**
 * Tests shared provider model helpers.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_BY_MODEL_REPLAY_HOOKS,
  buildProviderReplayFamilyHooks,
  modelCostsEqual,
  NATIVE_ANTHROPIC_REPLAY_HOOKS,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
  PASSTHROUGH_GEMINI_REPLAY_HOOKS,
  resolveClaudeFable5ModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  resolveClaudeThinkingProfile,
  requiresClaudeDefaultSampling,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "./provider-model-shared.js";

const EXPECTED_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
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

describe("Claude model contracts", () => {
  it("recognizes Vertex date suffixes", () => {
    expect(resolveClaudeFable5ModelIdentity({ id: "claude-fable-5@20260601" })).toBe(
      "claude-fable-5@20260601",
    );
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-6@20260301" })).toBe(true);
    expect(supportsClaudeNativeXhighEffort({ id: "claude-opus-4-8@20260401" })).toBe(true);
    expect(resolveClaudeSonnet5ModelIdentity({ id: "claude-sonnet-5@20260701" })).toBe(
      "claude-sonnet-5@20260701",
    );
  });

  it("recognizes Claude Mythos 5 as mandatory adaptive with native max effort", () => {
    expect(resolveClaudeMythos5ModelIdentity({ id: "us.anthropic.claude-mythos-5-v1:0" })).toBe(
      "claude-mythos-5-v1:0",
    );
    expect(supportsClaudeAdaptiveThinking({ id: "claude-mythos-5" })).toBe(true);
    expect(supportsClaudeNativeMaxEffort({ id: "claude-mythos-5" })).toBe(true);
    expect(supportsClaudeNativeXhighEffort({ id: "anthropic.claude-mythos-5" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-mythos-5" })).toBe(true);
  });

  it("does not classify later numeric model versions as supported aliases", () => {
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-4-60" })).toBe(false);
    expect(supportsClaudeAdaptiveThinking({ id: "claude-sonnet-50" })).toBe(false);
    expect(supportsClaudeAdaptiveThinking({ id: "claude-mythos-50" })).toBe(false);
    expect(supportsClaudeNativeXhighEffort({ id: "claude-opus-4-80" })).toBe(false);
    expect(requiresClaudeDefaultSampling({ id: "claude-opus-4-8" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-mythos-preview" })).toBe(true);
    expect(requiresClaudeDefaultSampling({ id: "claude-opus-4-6" })).toBe(false);
    expect(readLevelIds(resolveClaudeThinkingProfile("claude-opus-4-80"))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("modelCostsEqual", () => {
  it("matches complete flat rates and rejects missing or stale metadata", () => {
    expect(modelCostsEqual(EXPECTED_COST, EXPECTED_COST)).toBe(true);
    expect(modelCostsEqual(undefined, EXPECTED_COST)).toBe(false);
    expect(modelCostsEqual({ ...EXPECTED_COST, output: 15 }, EXPECTED_COST)).toBe(false);
  });
});

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
  it("defaults Sonnet 5 to high adaptive thinking with native effort levels", () => {
    const profile = resolveClaudeThinkingProfile("claude-sonnet-5");
    expectFields(profile, { defaultLevel: "high" });
    expectLevelIdsInclude(profile, ["off", "xhigh", "adaptive", "max"]);
  });

  it.each(["claude-fable-5", "claude-mythos-5"])(
    "exposes %s's mandatory-adaptive profile to Claude providers",
    (modelId) => {
      const profile = resolveClaudeThinkingProfile(modelId);
      expectFields(profile, {
        defaultLevel: "high",
        preserveWhenCatalogReasoningFalse: true,
      });
      expectLevelIdsInclude(profile, ["xhigh", "adaptive", "max"]);
    },
  );

  it("does not match longer unrelated Claude ids by prefix only", () => {
    expect(resolveClaudeThinkingProfile("vendor/claude-fable-500").defaultLevel).toBeUndefined();
    expect(resolveClaudeThinkingProfile("anthropic/claude-opus-4-60").defaultLevel).toBeUndefined();
    expect(supportsClaudeNativeMaxEffort({ id: "vendor/claude-fable-500" })).toBe(false);
    expect(supportsClaudeNativeXhighEffort({ id: "anthropic/claude-opus-4-70" })).toBe(false);
  });

  it("leaves Opus 4.8 thinking off by default with xhigh/adaptive/max options", () => {
    const profile = resolveClaudeThinkingProfile("claude-opus-4-8");
    expectFields(profile, {
      defaultLevel: "off",
    });
    expectLevelIdsInclude(profile, ["xhigh", "adaptive", "max"]);
  });

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
