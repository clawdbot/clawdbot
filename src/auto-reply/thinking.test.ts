import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderThinkingProfile: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
}));

let listThinkingLevelLabels: typeof import("./thinking.js").listThinkingLevelLabels;
let listThinkingLevels: typeof import("./thinking.js").listThinkingLevels;
let normalizeReasoningLevel: typeof import("./thinking.js").normalizeReasoningLevel;
let normalizeThinkLevel: typeof import("./thinking.js").normalizeThinkLevel;
let resolveSupportedThinkingLevel: typeof import("./thinking.js").resolveSupportedThinkingLevel;
let resolveThinkingDefaultForModel: typeof import("./thinking.js").resolveThinkingDefaultForModel;

async function loadFreshThinkingModuleForTest() {
  vi.resetModules();
  vi.doMock("../plugins/provider-thinking.js", () => ({
    resolveProviderBinaryThinking: providerRuntimeMocks.resolveProviderBinaryThinking,
    resolveProviderDefaultThinkingLevel: providerRuntimeMocks.resolveProviderDefaultThinkingLevel,
    resolveProviderThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
    resolveProviderXHighThinking: providerRuntimeMocks.resolveProviderXHighThinking,
  }));
  return await import("./thinking.js");
}

beforeEach(async () => {
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReset();
  providerRuntimeMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReset();
  providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
  providerRuntimeMocks.resolveProviderXHighThinking.mockReset();
  providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(undefined);

  ({
    listThinkingLevelLabels,
    listThinkingLevels,
    normalizeReasoningLevel,
    normalizeThinkLevel,
    resolveSupportedThinkingLevel,
    resolveThinkingDefaultForModel,
  } = await loadFreshThinkingModuleForTest());
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
      (provider === "openai" && ["gpt-5.4", "gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)) ||
      (provider === "openai-codex" &&
        ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex-spark"].includes(context.modelId)) ||
      (provider === "github-copilot" && ["gpt-5.4", "gpt-5.4"].includes(context.modelId))
        ? true
        : undefined,
    );

    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.3-codex-spark")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4-pro")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("openai", "gpt-5.4-pro")).toContain("xhigh");
    expect(listThinkingLevels("openai-codex", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.4")).toContain("xhigh");
    expect(listThinkingLevels("github-copilot", "gpt-5.4")).toContain("xhigh");
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("does not include max without provider support", () => {
    expect(listThinkingLevels("openai", "gpt-5.4")).not.toContain("max");
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

  it("uses provider thinking profiles ahead of legacy hooks", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    providerRuntimeMocks.resolveProviderXHighThinking.mockReturnValue(true);

    expect(listThinkingLevels("demo", "demo-model")).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
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

  it("uses provider-advertised adaptive defaults for Bedrock aliases", () => {
    providerRuntimeMocks.resolveProviderDefaultThinkingLevel.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? "adaptive"
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("adaptive");
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
