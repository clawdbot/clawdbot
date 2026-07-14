/** Tests thinking, reasoning, verbosity, and usage directive normalization. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderThinkingProfile: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: providerRuntimeMocks.resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel: providerRuntimeMocks.resolveProviderDefaultThinkingLevel,
  resolveProviderThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
  resolveProviderXHighThinking: providerRuntimeMocks.resolveProviderXHighThinking,
}));

const {
  listThinkingLevelLabels,
  listThinkingLevelOptions,
  listThinkingLevels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  isThinkingLevelSupported,
  formatThinkingLevels,
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
  resolveEffectiveResponseUsage,
} = await import("./thinking.js");

beforeEach(() => {
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReset();
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReset();
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderXHighThinking.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(undefined);
});

describe("normalizeThinkLevel", () => {
  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });

  it("accepts adaptive and auto aliases", () => {
    expect(normalizeThinkLevel("adaptive")).toBe("adaptive");
    expect(normalizeThinkLevel("auto")).toBe("adaptive");
    expect(normalizeThinkLevel("Adaptive")).toBe("adaptive");
  });

  it("accepts max as its own level", () => {
    expect(normalizeThinkLevel("max")).toBe("max");
    expect(normalizeThinkLevel("MAX")).toBe("max");
  });

  it("keeps explicit Ultra distinct from the legacy ultrathink alias", () => {
    expect(normalizeThinkLevel("ultra")).toBe("ultra");
    expect(normalizeThinkLevel("ULTRA")).toBe("ultra");
    expect(normalizeThinkLevel("ultrathink")).toBe("high");
  });
});

describe("listThinkingLevels", () => {
  it("uses provider runtime hooks for xhigh support", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
  });

  it("uses provider runtime hooks for xhigh labels", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevelLabels("demo", "demo-model")).toContain("xhigh");
  });

  it("includes xhigh for provider-advertised models", () => {
    providerRuntimeMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      (provider === "openai" &&
        ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex-spark"].includes(context.modelId)) ||
      (provider === "github-copilot" && context.modelId === "gpt-5.4")
        ? true
        : undefined,
    );

    for (const [provider, model] of [
      ["openai", "gpt-5.4"],
      ["openai", "gpt-5.4-pro"],
      ["openai", "gpt-5.3-codex-spark"],
      ["github-copilot", "gpt-5.4"],
    ] as const) {
      expect(listThinkingLevels(provider, model)).toContain("xhigh");
    }
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("does not include max without provider support", () => {
    expect(listThinkingLevels("openai", "gpt-5.4")).not.toContain("max");
  });

  it("passes the effective agent runtime into provider thinking profiles", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels: [
        { id: "off" },
        { id: "max" },
        ...(context.agentRuntime === "openclaw" ? [{ id: "ultra" as const }] : []),
      ],
    }));

    expect(listThinkingLevels("openai", "gpt-5.6-luna", undefined, "openclaw")).toContain("ultra");
    expect(listThinkingLevels("openai", "gpt-5.6-luna", undefined, "codex")).not.toContain("ultra");
    expect(providerRuntimeMocks.resolveProviderThinkingProfile).toHaveBeenLastCalledWith({
      provider: "openai",
      context: expect.objectContaining({ agentRuntime: "codex" }),
    });
  });

  it("does not include adaptive without provider support", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("adaptive");
    expect(listThinkingLevels("openai", "gpt-5.4")).not.toContain("adaptive");
  });

  it("uses provider thinking profiles for adaptive and max support", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "anthropic"
        ? { levels: [{ id: "off" }, { id: "adaptive" }, { id: "max" }] }
        : undefined,
    );

    expect(listThinkingLevels("anthropic", "claude-opus-4-6")).toContain("adaptive");
    expect(listThinkingLevels("anthropic", "claude-opus-4-7")).toContain("max");
  });

  it("preserves provider profile ids and labels", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "adaptive", label: "auto" }, { id: "max", label: "maximum" }],
      defaultLevel: "adaptive",
    });

    expect(listThinkingLevelOptions("demo", "demo-model")).toEqual([
      { id: "off", label: "off" },
      { id: "adaptive", label: "auto" },
      { id: "max", label: "maximum" },
    ]);
  });

  it("uses provider thinking profiles ahead of legacy hooks", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevels("demo", "demo-model")).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("treats catalog reasoning=false as an explicit thinking opt-out", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    const catalog = [
      {
        provider: "google",
        id: "gemma-4-26b-a4b-it",
        name: "Gemma 4 26B",
        reasoning: false,
      },
    ];

    expect(listThinkingLevels("google", "gemma-4-26b-a4b-it", catalog)).toEqual(["off"]);
    expect(
      isThinkingLevelSupported({
        provider: "google",
        model: "gemma-4-26b-a4b-it",
        level: "medium",
        catalog,
      }),
    ).toBe(false);
    expect(
      resolveThinkingDefaultForModel({
        provider: "google",
        model: "gemma-4-26b-a4b-it",
        catalog,
      }),
    ).toBe("off");
  });

  it("preserves provider-authoritative thinking profiles over stale catalog reasoning", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }],
      preserveWhenCatalogReasoningFalse: true,
    });
    const catalog = [
      {
        provider: "google",
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: false,
      },
    ];

    expect(
      isThinkingLevelSupported({
        provider: "google",
        model: "gemini-3-flash-preview",
        level: "low",
        catalog,
      }),
    ).toBe(true);
    expect(
      resolveSupportedThinkingLevel({
        provider: "google",
        model: "gemini-3-flash-preview",
        level: "low",
        catalog,
      }),
    ).toBe("low");
  });

  it("passes catalog reasoning into provider thinking profiles for support checks", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels:
        context.reasoning === true
          ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
          : [{ id: "off" }],
      defaultLevel: "off",
    }));
    const catalog = [{ provider: "ollama", id: "gpt-oss:20b", name: "gpt-oss", reasoning: true }];

    expect(
      isThinkingLevelSupported({
        provider: "ollama",
        model: "gpt-oss:20b",
        level: "max",
        catalog,
      }),
    ).toBe(true);
    expect(formatThinkingLevels("ollama", "gpt-oss:20b", ", ", catalog)).toBe(
      "off, low, medium, high, max",
    );
    expect(
      resolveSupportedThinkingLevel({
        provider: "ollama",
        model: "gpt-oss:20b",
        level: "max",
        catalog,
      }),
    ).toBe("max");
  });

  it("passes catalog compat into provider thinking profiles", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) =>
      context.reasoning === true && context.compat?.thinkingFormat === "qwen-chat-template"
        ? {
            levels: [{ id: "off" }, { id: "low", label: "on" }],
            defaultLevel: "off",
          }
        : undefined,
    );
    const catalog = [
      {
        provider: "vllm",
        id: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ];

    expect(listThinkingLevelLabels("vllm", "Qwen/Qwen3-8B", catalog)).toEqual(["off", "on"]);
    expect(
      resolveSupportedThinkingLevel({
        provider: "vllm",
        model: "Qwen/Qwen3-8B",
        level: "high",
        catalog,
      }),
    ).toBe("low");
  });

  it("uses canonical Fable params when no provider thinking profile exists", () => {
    const catalog = [
      {
        provider: "microsoft-foundry",
        id: "company-fable",
        api: "anthropic-messages",
        reasoning: false,
        params: { canonicalModelId: "claude-fable-5" },
      },
    ];

    expect(listThinkingLevels("microsoft-foundry", "company-fable", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "adaptive",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      resolveThinkingDefaultForModel({
        provider: "microsoft-foundry",
        model: "company-fable",
        catalog,
      }),
    ).toBe("high");
  });

  it("exposes Claude Opus xhigh on custom anthropic-messages providers without a plugin profile", () => {
    // Regression for openclaw#91975: a renamed provider serving Claude Opus over
    // anthropic-messages used to fall back to a base profile (no xhigh) and silently
    // clamp `--thinking xhigh` to `off`.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-opus-4.7-hq",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "claude-opus-4.7-hq", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "adaptive",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      isThinkingLevelSupported({
        provider: "jdcloud-anthropic",
        model: "claude-opus-4.7-hq",
        level: "xhigh",
        catalog,
      }),
    ).toBe(true);
    expect(
      resolveSupportedThinkingLevel({
        provider: "jdcloud-anthropic",
        model: "claude-opus-4.7-hq",
        level: "xhigh",
        catalog,
      }),
    ).toBe("xhigh");
  });

  it("does not invent xhigh for non-Claude models on anthropic-messages routes", () => {
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "some-non-claude-model",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "some-non-claude-model", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("intentionally suppresses compat-driven xhigh for non-Claude anthropic-messages rows", () => {
    // Even when the catalog explicitly advertises xhigh via compat, a non-Claude
    // model on the anthropic-messages transport stays on the Claude base set.
    // The transport itself doesn't carry a generic xhigh contract — only Claude
    // families do — so the catalog signal is intentionally suppressed here.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "some-non-claude-model",
        api: "anthropic-messages",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "some-non-claude-model", catalog)).not.toContain(
      "xhigh",
    );
  });

  it("does not infer the Claude profile without an anthropic-messages catalog row", () => {
    // Same provider id, but the catalog row says openai-completions — must NOT
    // grant Claude levels to a non-Anthropic transport.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-opus-4.7-hq",
        api: "openai-completions",
        reasoning: true,
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "claude-opus-4.7-hq", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("matches native Anthropic max parity for adaptive Claude on custom anthropic-messages providers", () => {
    // Adaptive Claude families (e.g. claude-sonnet-4-6) take the adaptive-default
    // branch in resolveClaudeThinkingProfile, which only exposes `max` when
    // includeNativeMax is set. The fallback must pass the same option the
    // bundled anthropic plugin uses, otherwise custom providers silently lose
    // `max` parity with the native Anthropic policy.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "claude-sonnet-4-6", catalog)).toContain("max");
    expect(
      isThinkingLevelSupported({
        provider: "jdcloud-anthropic",
        model: "claude-sonnet-4-6",
        level: "max",
        catalog,
      }),
    ).toBe(true);
  });

  it("preserves provider-specific profiles for Fable Messages routes", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
      defaultLevel: "off",
    });

    expect(
      listThinkingLevels("proxy", "company-fable", [
        {
          provider: "proxy",
          id: "company-fable",
          api: "anthropic-messages",
          reasoning: true,
          params: { canonicalModelId: "claude-fable-5" },
        },
      ]),
    ).toEqual(["off", "low"]);
  });

  it("does not infer the Fable contract without an Anthropic Messages catalog row", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
      defaultLevel: "off",
    });

    expect(listThinkingLevels("openrouter", "anthropic/claude-fable-5")).toEqual(["off", "low"]);
  });

  it("does not apply the Fable profile to OpenAI-compatible catalog rows", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }],
      defaultLevel: "off",
    });

    expect(
      listThinkingLevels("openrouter", "anthropic/claude-fable-5", [
        {
          provider: "openrouter",
          id: "anthropic/claude-fable-5",
          api: "openai-completions",
          reasoning: true,
        },
      ]),
    ).toEqual(["off", "low", "high"]);
  });

  it("preserves explicit provider opt-outs for canonical Fable aliases", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    const catalog = [
      {
        provider: "claude-cli",
        id: "company-fable",
        api: "anthropic-messages",
        reasoning: true,
        params: { canonicalModelId: "claude-fable-5" },
      },
    ];

    expect(listThinkingLevels("claude-cli", "company-fable", catalog)).toEqual(["off"]);
  });

  it("uses generic thinking levels when a provider has no custom profile", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(null);

    expect(
      listThinkingLevels("vllm", "reasoning-model", [
        {
          provider: "vllm",
          id: "reasoning-model",
          reasoning: true,
        },
      ]),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("matches provider-qualified catalog ids for provider thinking profiles", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) =>
      context.reasoning === true && context.compat?.thinkingFormat === "qwen-chat-template"
        ? {
            levels: [{ id: "off" }, { id: "low", label: "on" }],
            defaultLevel: "off",
          }
        : undefined,
    );
    const catalog = [
      {
        provider: "vllm",
        id: "vllm/Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ];

    expect(listThinkingLevelLabels("vllm", "Qwen/Qwen3-8B", catalog)).toEqual(["off", "on"]);
    expect(
      resolveSupportedThinkingLevel({
        provider: "vllm",
        model: "Qwen/Qwen3-8B",
        level: "high",
        catalog,
      }),
    ).toBe("low");
  });

  it("uses catalog compat reasoning efforts to expose xhigh for configured custom models", () => {
    const catalog = [
      {
        provider: "gmn",
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ];

    expect(listThinkingLevels("gmn", "gpt-5.4", catalog)).toContain("xhigh");
    expect(formatThinkingLevels("gmn", "gpt-5.4", ", ", catalog)).toBe(
      "off, minimal, low, medium, high, xhigh",
    );
    expect(
      isThinkingLevelSupported({
        provider: "gmn",
        model: "gpt-5.4",
        level: "xhigh",
        catalog,
      }),
    ).toBe(true);
  });

  it("does not let catalog xhigh compat override binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(true);
    const catalog = [
      {
        provider: "zai",
        id: "glm-4.7",
        name: "GLM 4.7",
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ];

    expect(listThinkingLevels("zai", "glm-4.7", catalog)).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("zai", "glm-4.7", catalog)).toEqual(["off", "on"]);
  });

  it("maps stale unsupported levels to the largest profile level", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "high" }],
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "demo",
        model: "demo-model",
        level: "max",
      }),
    ).toBe("high");
  });

  it("maps xhigh to high for provider profiles with max but no xhigh", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "anthropic"
        ? {
            levels: [
              { id: "off" },
              { id: "minimal" },
              { id: "low" },
              { id: "medium" },
              { id: "high" },
              { id: "adaptive" },
              { id: "max" },
            ],
          }
        : undefined,
    );

    expect(
      resolveSupportedThinkingLevel({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        level: "xhigh",
      }),
    ).toBe("high");
  });

  it("maps unsupported adaptive to medium and unsupported xhigh to high", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-5.4",
        level: "adaptive",
      }),
    ).toBe("medium");
    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-4.1-mini",
        level: "xhigh",
      }),
    ).toBe("high");
  });

  it("clamps a below-range request down to the cheapest level on a no-off profile", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "demo-noff",
        model: "demo-model",
        level: "off",
      }),
    ).toBe("low");
  });
});

describe("listThinkingLevelLabels", () => {
  it("uses provider runtime hooks for binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(true);

    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("returns on/off for provider-advertised binary thinking", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockImplementation(({ provider }) =>
      provider === "zai" ? true : undefined,
    );

    expect(listThinkingLevelLabels("zai", "glm-4.7")).toEqual(["off", "on"]);
  });

  it("does not assume binary thinking without provider runtime", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toContain("low");
    expect(listThinkingLevelLabels("zai", "glm-4.7")).not.toContain("on");
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("uses provider runtime hooks for default thinking levels", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue("adaptive");

    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model" })).toBe(
      "adaptive",
    );
  });

  it("uses provider-advertised adaptive defaults", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" && context.modelId === "claude-opus-4-6" ? "adaptive" : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("adaptive");
  });

  it("does not apply provider-advertised adaptive defaults across Bedrock id variants", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? "adaptive"
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("does not assume adaptive defaults without provider runtime", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("off");
    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("defaults reasoning-capable catalog models to medium", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-5.4",
        catalog: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("remaps implicit reasoning defaults to the strongest supported level at or below medium", () => {
    providerRuntimeMocks.resolveProviderBinaryThinking.mockImplementation(
      ({ provider }) => provider === "demo-binary",
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-binary",
        model: "demo-model",
        catalog: [{ provider: "demo-binary", id: "demo-model", reasoning: true }],
      }),
    ).toBe("low");
  });

  it("keeps catalog reasoning context when remapping implicit reasoning defaults", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "demo-contextual" && context.reasoning
          ? { levels: [{ id: "off" }, { id: "low" }, { id: "medium" }] }
          : provider === "demo-contextual"
            ? { levels: [{ id: "off" }] }
            : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-contextual",
        model: "demo-model",
        catalog: [{ provider: "demo-contextual", id: "demo-model", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("defaults to off when no adaptive or reasoning hint is present", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-4.1-mini",
        catalog: [{ provider: "openai", id: "gpt-4.1-mini", reasoning: false }],
      }),
    ).toBe("off");
  });

  it("respects provider-declared 'off' default for reasoning-capable models", () => {
    // Providers like Ollama declare defaultLevel:"off" even for reasoning=true models
    // because thinking must be explicitly opted in, not activated by the global default.
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "ollama"
        ? {
            levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
            defaultLevel: "off",
          }
        : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "ollama",
        model: "gemma4",
        catalog: [{ provider: "ollama", id: "gemma4", reasoning: true }],
      }),
    ).toBe("off");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});

describe("resolveEffectiveResponseUsage", () => {
  it("returns off when session is unset and no config is provided", () => {
    expect(resolveEffectiveResponseUsage(undefined, undefined)).toBe("off");
    expect(resolveEffectiveResponseUsage(null, undefined)).toBe("off");
  });

  it("applies config default when session is unset", () => {
    expect(resolveEffectiveResponseUsage(undefined, "tokens")).toBe("tokens");
    expect(resolveEffectiveResponseUsage(undefined, "full")).toBe("full");
  });

  it("applies per-channel config entry when session is unset", () => {
    const cfg = { default: "off", discord: "full", telegram: "tokens" } as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg, "discord")).toBe("full");
    expect(resolveEffectiveResponseUsage(undefined, cfg, "telegram")).toBe("tokens");
    // Unknown channel falls back to config default
    expect(resolveEffectiveResponseUsage(undefined, cfg, "whatsapp")).toBe("off");
  });

  it("session explicit off overrides any config default", () => {
    // Explicit "off" is stored and wins — non-off config default cannot re-enable it.
    expect(resolveEffectiveResponseUsage("off", "tokens")).toBe("off");
    expect(resolveEffectiveResponseUsage("off", "full")).toBe("off");
    expect(
      resolveEffectiveResponseUsage("off", { default: "full", discord: "full" }, "discord"),
    ).toBe("off");
  });

  it("session explicit on value overrides config default", () => {
    expect(resolveEffectiveResponseUsage("tokens", "full")).toBe("tokens");
    expect(resolveEffectiveResponseUsage("full", "off")).toBe("full");
  });

  it("unset (undefined/null) falls through to config; explicit off does not", () => {
    // These two are distinct states:
    // - undefined = unset/inherit → gets config default
    // - "off"     = explicit off  → stays off
    const cfg = "tokens" as const;
    expect(resolveEffectiveResponseUsage(undefined, cfg)).toBe("tokens"); // inherits
    expect(resolveEffectiveResponseUsage("off", cfg)).toBe("off"); // explicit off persists
  });
});
