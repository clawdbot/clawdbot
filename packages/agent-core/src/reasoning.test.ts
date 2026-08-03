import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { resolveAgentReasoningOption } from "./reasoning.js";

function makeModel(
  thinkingLevelMap?: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevelMap,
    ...overrides,
  };
}

describe("resolveAgentReasoningOption", () => {
  it("uses a model's enabled fallback for explicit off", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "off")).toBe("low");
  });

  it.each([undefined, null, "none"])("disables reasoning when off maps to %s", (offFallback) => {
    expect(resolveAgentReasoningOption(makeModel({ off: offFallback }), "off")).toBeUndefined();
  });

  it("preserves enabled thinking levels", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "high")).toBe("high");
  });

  it("preserves explicit off for Sonnet 5 on Anthropic Messages routes", () => {
    expect(
      resolveAgentReasoningOption(makeModel(undefined, { id: "claude-sonnet-5" }), "off"),
    ).toBe("off");
  });

  it("uses the route-owned Sonnet 5 off mapping when provided", () => {
    expect(
      resolveAgentReasoningOption(
        makeModel({ off: "low" }, { id: "anthropic.claude-sonnet-5" }),
        "off",
      ),
    ).toBe("low");
  });

  it.each(["anthropic-messages", "bedrock-converse-stream"] as const)(
    "maps explicit off to low for canonical Fable aliases on %s",
    (api) => {
      expect(
        resolveAgentReasoningOption(
          makeModel(undefined, {
            id: "production-deployment",
            api,
            params: { canonicalModelId: "claude-fable-5" },
          }),
          "off",
        ),
      ).toBe("low");
    },
  );
});
