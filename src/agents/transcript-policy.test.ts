import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  const replayHelpers = await vi.importActual<
    typeof import("../plugins/provider-replay-helpers.js")
  >("../plugins/provider-replay-helpers.js");
  return {
    ...actual,
    resolveProviderRuntimePlugin: vi.fn(({ provider }: { provider?: string }) => {
      if (
        !provider ||
        ![
          "amazon-bedrock",
          "anthropic",
          "google",
          "github-copilot",
          "kilocode",
          "kimi",
          "kimi-code",
          "minimax",
          "minimax-portal",
          "mistral",
          "moonshot",
          "openai",
          "openai-codex",
          "opencode",
          "opencode-go",
          "ollama",
          "openrouter",
          "sglang",
          "vllm",
          "xai",
          "zai",
        ].includes(provider)
      ) {
        return undefined;
      }
      if (provider === "sglang" || provider === "vllm") {
        return {};
      }
      return {
        buildReplayPolicy: (context?: { modelId?: string; modelApi?: string }) => {
          const modelId = context?.modelId?.toLowerCase() ?? "";
          switch (provider) {
            case "amazon-bedrock":
            case "anthropic":
              return {
                sanitizeMode: "full",
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict",
                preserveSignatures: true,
                repairToolUseResultPairing: true,
                validateAnthropicTurns: true,
                allowSyntheticToolResults: true,
                ...(modelId.includes("claude") &&
                !replayHelpers.shouldPreserveThinkingBlocks(modelId)
                  ? { dropThinkingBlocks: true }
                  : {}),
              };
            case "minimax":
            case "minimax-portal":
              return context?.modelApi === "openai-completions"
                ? {
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    applyAssistantFirstOrderingFix: true,
                    validateGeminiTurns: true,
                    validateAnthropicTurns: true,
                  }
                : {
                    sanitizeMode: "full",
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    preserveSignatures: true,
                    repairToolUseResultPairing: true,
                    validateAnthropicTurns: true,
                    allowSyntheticToolResults: true,
                    ...(modelId.includes("claude") &&
                    !replayHelpers.shouldPreserveThinkingBlocks(modelId)
                      ? { dropThinkingBlocks: true }
                      : {}),
                  };
            case "moonshot":
            case "ollama":
            case "zai":
              return context?.modelApi === "openai-completions"
                ? {
                    sanitizeToolCallIds: true,
                    toolCallIdMode: "strict",
                    applyAssistantFirstOrderingFix: true,
                    validateGeminiTurns: true,
                    validateAnthropicTurns: true,
                  }
                : undefined;
            case "google":
              return {
                sanitizeMode: "full",
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict",
                sanitizeThoughtSignatures: {
                  allowBase64Only: true,
                  includeCamelCase: true,
                },
                repairToolUseResultPairing: true,
                applyAssistantFirstOrderingFix: true,
                validateGeminiTurns: true,
                validateAnthropicTurns: false,
                allowSyntheticToolResults: true,
              };
            case "github-copilot":
              return modelId.includes("claude")
                ? {
                    dropThinkingBlocks: true,
                  }
                : {};
            case "mistral":
              return {
                sanitizeToolCallIds: true,
                toolCallIdMode: "strict9",
              };
            case "openai":
            case "openai-codex":
              return {
                sanitizeMode: "images-only",
                sanitizeToolCallIds: context?.modelApi === "openai-completions",
                ...(context?.modelApi === "openai-completions" ? { toolCallIdMode: "strict" } : {}),
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
              };
            case "kimi":
            case "kimi-code":
              return {
                preserveSignatures: false,
              };
            case "openrouter":
            case "opencode":
            case "opencode-go":
              return {
                applyAssistantFirstOrderingFix: false,
                validateGeminiTurns: false,
                validateAnthropicTurns: false,
                ...(modelId.includes("gemini")
                  ? {
                      sanitizeThoughtSignatures: {
                        allowBase64Only: true,
                        includeCamelCase: true,
                      },
                    }
                  : {}),
              };
            case "xai":
              if (
                context?.modelApi === "openai-completions" ||
                context?.modelApi === "openai-responses"
              ) {
                return {
                  sanitizeToolCallIds: true,
                  toolCallIdMode: "strict",
                  ...(context.modelApi === "openai-completions"
                    ? {
                        applyAssistantFirstOrderingFix: true,
                        validateGeminiTurns: true,
                        validateAnthropicTurns: true,
                      }
                    : {
                        applyAssistantFirstOrderingFix: false,
                        validateGeminiTurns: false,
                        validateAnthropicTurns: false,
                      }),
                };
              }
              return undefined;
            case "kilocode":
              return modelId.includes("gemini")
                ? {
                    sanitizeThoughtSignatures: {
                      allowBase64Only: true,
                      includeCamelCase: true,
                    },
                  }
                : undefined;
            default:
              return undefined;
          }
        },
      };
    }),
    resetProviderRuntimeHookCacheForTest: vi.fn(),
  };
});

let resolveTranscriptPolicy: typeof import("./transcript-policy.js").resolveTranscriptPolicy;
let shouldAllowProviderOwnedThinkingReplay: typeof import("./transcript-policy.js").shouldAllowProviderOwnedThinkingReplay;

describe("resolveTranscriptPolicy", () => {
  beforeAll(async () => {
    ({ resolveTranscriptPolicy, shouldAllowProviderOwnedThinkingReplay } =
      await import("./transcript-policy.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables sanitizeToolCallIds for Anthropic provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables sanitizeToolCallIds for Google provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "google",
      modelId: "gemini-2.0-flash",
      modelApi: "google-generative-ai",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });

  it("enables sanitizeToolCallIds for Mistral provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "mistral",
      modelId: "mistral-large-latest",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict9");
  });

  it("disables sanitizeToolCallIds for OpenAI provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai",
    });
    expect(policy.sanitizeToolCallIds).toBe(false);
    expect(policy.toolCallIdMode).toBeUndefined();
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it("enables strict tool call id sanitization for openai-completions APIs", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
  });

  it("enables user-turn merge for strict OpenAI-compatible providers", () => {
    const policy = resolveTranscriptPolicy({
      provider: "moonshot",
      modelId: "kimi-k2.5",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("falls back to unowned transport defaults when no owning plugin exists", () => {
    const policy = resolveTranscriptPolicy({
      provider: "custom-openai-proxy",
      modelId: "demo-model",
      modelApi: "openai-completions",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("preserves thinking blocks for newer Claude models in unowned Anthropic transport fallback", () => {
    // Opus 4.6 via custom proxy: should NOT drop thinking blocks
    const opus46 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
    });
    expect(opus46.dropThinkingBlocks).toBe(false);

    // Sonnet 4.5 via custom proxy: should NOT drop
    const sonnet45 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-sonnet-4-5-20250929",
      modelApi: "anthropic-messages",
    });
    expect(sonnet45.dropThinkingBlocks).toBe(false);

    // Legacy Sonnet 3.7 via custom proxy: SHOULD drop
    const sonnet37 = resolveTranscriptPolicy({
      provider: "custom-anthropic-proxy",
      modelId: "claude-3-7-sonnet-20250219",
      modelApi: "anthropic-messages",
    });
    expect(sonnet37.dropThinkingBlocks).toBe(true);
  });

  it("preserves transport defaults when a runtime plugin has not adopted replay hooks", () => {
    const policy = resolveTranscriptPolicy({
      provider: "vllm",
      modelId: "demo-model",
      modelApi: "openai-completions",
    });

    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("uses provider-owned Anthropic replay policy for MiniMax transports", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      modelApi: "anthropic-messages",
    });

    expect(policy.sanitizeMode).toBe("full");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.preserveSignatures).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("uses provider-owned OpenAI-compatible replay policy for MiniMax portal completions", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax-portal",
      modelId: "MiniMax-M2.7",
      modelApi: "openai-completions",
    });

    expect(policy.sanitizeMode).toBe("images-only");
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.toolCallIdMode).toBe("strict");
    expect(policy.preserveSignatures).toBe(false);
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("enables Anthropic-compatible policies for Bedrock provider", () => {
    const policy = resolveTranscriptPolicy({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream",
    });
    expect(policy.repairToolUseResultPairing).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
    expect(policy.allowSyntheticToolResults).toBe(true);
    expect(policy.sanitizeToolCallIds).toBe(true);
    expect(policy.sanitizeMode).toBe("full");
  });

  it.each([
    {
      title: "Anthropic provider",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: true,
    },
    {
      title: "Bedrock Anthropic",
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream" as const,
      preserveSignatures: true,
    },
    {
      title: "Google provider",
      provider: "google",
      modelId: "gemini-2.0-flash",
      modelApi: "google-generative-ai" as const,
      preserveSignatures: false,
    },
    {
      title: "OpenAI provider",
      provider: "openai",
      modelId: "gpt-4o",
      modelApi: "openai" as const,
      preserveSignatures: false,
    },
    {
      title: "Mistral provider",
      provider: "mistral",
      modelId: "mistral-large-latest",
      preserveSignatures: false,
    },
    {
      title: "Kimi provider",
      provider: "kimi",
      modelId: "kimi-code",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: false,
    },
    {
      title: "kimi-code alias",
      provider: "kimi-code",
      modelId: "kimi-code",
      modelApi: "anthropic-messages" as const,
      preserveSignatures: false,
    },
  ])("sets preserveSignatures for $title (#32526, #39798)", ({ preserveSignatures, ...input }) => {
    const policy = resolveTranscriptPolicy(input);
    expect(policy.preserveSignatures).toBe(preserveSignatures);
  });

  it("allows immutable provider-owned thinking replay for anthropic-compatible native replay policies", () => {
    const policy = resolveTranscriptPolicy({
      provider: "minimax",
      modelId: "MiniMax-M2.7",
      modelApi: "anthropic-messages",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "anthropic-messages",
        policy,
      }),
    ).toBe(true);
  });

  it("allows immutable provider-owned thinking replay for bedrock claude replay policies", () => {
    const policy = resolveTranscriptPolicy({
      provider: "amazon-bedrock",
      modelId: "us.anthropic.claude-opus-4-6-v1",
      modelApi: "bedrock-converse-stream",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "bedrock-converse-stream",
        policy,
      }),
    ).toBe(true);
  });

  it("does not allow immutable provider-owned thinking replay for github-copilot claude models", () => {
    const policy = resolveTranscriptPolicy({
      provider: "github-copilot",
      modelId: "claude-sonnet-4",
      modelApi: "anthropic-messages",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "anthropic-messages",
        policy,
      }),
    ).toBe(false);
  });

  it("does not allow immutable provider-owned thinking replay for openrouter models on openai replay", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-4-6",
      modelApi: "openai-completions",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "openai-completions",
        policy,
      }),
    ).toBe(false);
  });

  it("does not allow immutable provider-owned thinking replay for strict openai-compatible replay", () => {
    const policy = resolveTranscriptPolicy({
      provider: "vllm",
      modelId: "gemma-3-27b",
      modelApi: "openai-completions",
    });
    expect(
      shouldAllowProviderOwnedThinkingReplay({
        modelApi: "openai-completions",
        policy,
      }),
    ).toBe(false);
  });

  it("enables turn-ordering and assistant-merge for strict OpenAI-compatible providers (#38962)", () => {
    const policy = resolveTranscriptPolicy({
      provider: "vllm",
      modelId: "gemma-3-27b",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(true);
    expect(policy.validateGeminiTurns).toBe(true);
    expect(policy.validateAnthropicTurns).toBe(true);
  });

  it("keeps OpenRouter on its existing turn-validation path", () => {
    const policy = resolveTranscriptPolicy({
      provider: "openrouter",
      modelId: "openai/gpt-4.1",
      modelApi: "openai-completions",
    });
    expect(policy.applyGoogleTurnOrdering).toBe(false);
    expect(policy.validateGeminiTurns).toBe(false);
    expect(policy.validateAnthropicTurns).toBe(false);
  });

  it.each([
    { provider: "openrouter", modelId: "google/gemini-2.5-pro-preview" },
    { provider: "opencode", modelId: "google/gemini-2.5-flash" },
    { provider: "kilocode", modelId: "gemini-2.0-flash" },
  ])("sanitizes Gemini thought signatures for $provider routes", ({ provider, modelId }) => {
    const policy = resolveTranscriptPolicy({
      provider,
      modelId,
      modelApi: "openai-completions",
    });
    expect(policy.sanitizeThoughtSignatures).toEqual({
      allowBase64Only: true,
      includeCamelCase: true,
    });
  });
});
