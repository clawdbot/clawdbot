import { clampThinkingLevel, getSupportedThinkingLevels } from "@openclaw/ai/internal/runtime";
import { describe, expect, it } from "vitest";
import type { Model } from "./types.js";

type TestOpenAICompletionsModel = Model<"openai-completions">;
type TestOpenAIResponsesModel = Model<"openai-responses">;

const baseOpenAICompletionsModel = {
  id: "test-completions-model",
  name: "Test Completions Model",
  api: "openai-completions",
  provider: "custom",
  baseUrl: "https://example.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies TestOpenAICompletionsModel;

const baseOpenAIResponsesModel = {
  ...baseOpenAICompletionsModel,
  api: "openai-responses",
} satisfies TestOpenAIResponsesModel;

function makeModel(
  thinkingLevelMap: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://example.com",
    reasoning: true,
    thinkingLevelMap,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("clampThinkingLevel", () => {
  it("downgrades explicit extended-level opt-outs", () => {
    expect(clampThinkingLevel(makeModel({ xhigh: null, max: "max" }), "xhigh")).toBe("high");
  });

  it("keeps upward clamping for lower-level map holes", () => {
    expect(clampThinkingLevel(makeModel({ minimal: null }), "minimal")).toBe("low");
  });

  it("honors canonical Fable capabilities when catalog reasoning is stale", () => {
    const model = makeModel(undefined, {
      id: "company-fable",
      api: "anthropic-messages",
      provider: "microsoft-foundry",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("exposes xhigh when OpenAI-compatible metadata declares xhigh", () => {
    const model = {
      ...baseOpenAICompletionsModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
  });

  it("exposes xhigh when compat maps it to a declared provider effort", () => {
    const model = {
      ...baseOpenAIResponsesModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: { xhigh: "high" },
      },
    } satisfies TestOpenAIResponsesModel;

    expect(getSupportedThinkingLevels(model)).toContain("xhigh");
    expect(clampThinkingLevel(model, "xhigh")).toBe("xhigh");
  });

  it("does not expose mapped extended levels unless the provider value is declared", () => {
    const model = {
      ...baseOpenAICompletionsModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["xhigh"],
        reasoningEffortMap: { xhigh: "provider-xhigh" },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
    expect(clampThinkingLevel(model, "xhigh")).toBe("high");
  });

  it("exposes only off when compat reasoning is explicitly disabled", () => {
    const model = {
      ...baseOpenAIResponsesModel,
      compat: {
        supportsReasoningEffort: false,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
    } satisfies TestOpenAIResponsesModel;

    expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
    expect(clampThinkingLevel(model, "high")).toBe("off");
    expect(clampThinkingLevel(model, "xhigh")).toBe("off");
  });

  it("exposes max when compat declares a native max effort", () => {
    const model = {
      ...baseOpenAICompletionsModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "max"],
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("exposes max when compat maps it to a declared provider effort", () => {
    const model = {
      ...baseOpenAICompletionsModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "provider-max"],
        reasoningEffortMap: { max: "provider-max" },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });

  it("exposes max only with an explicit compat max-to-xhigh mapping", () => {
    const model = {
      ...baseOpenAICompletionsModel,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        reasoningEffortMap: { max: "xhigh" },
      },
    } satisfies TestOpenAICompletionsModel;

    expect(getSupportedThinkingLevels(model)).toContain("max");
    expect(clampThinkingLevel(model, "max")).toBe("max");
  });
});
