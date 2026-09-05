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

  it.each([undefined, "none"])("preserves explicit off when off maps to %s", (offFallback) => {
    expect(resolveAgentReasoningOption(makeModel({ off: offFallback }), "off")).toBe("off");
  });

  it("leaves unsupported off mapping to the transport", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: null }), "off")).toBeUndefined();
  });

  it("preserves enabled thinking levels", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "high")).toBe("high");
  });

  it.each(
    ["claude-sonnet-5", "anthropic.claude-opus-5"].flatMap((id) =>
      ([undefined, null, "none", "low"] as const).map((off) => ({ id, off })),
    ),
  )("retains the native $id exception with off=$off", ({ id, off }) => {
    expect(resolveAgentReasoningOption(makeModel({ off }, { id }), "off")).toBe(
      off === "low" ? "low" : "off",
    );
  });

  it.each(
    (["anthropic-messages", "bedrock-converse-stream"] as const).flatMap((api) =>
      ([undefined, null] as const).map((off) => ({ api, off })),
    ),
  )(
    "maps explicit off to low for canonical Fable aliases on $api with off=$off",
    ({ api, off }) => {
      expect(
        resolveAgentReasoningOption(
          makeModel(
            { off },
            {
              id: "production-deployment",
              api,
              params: { canonicalModelId: "claude-fable-5" },
            },
          ),
          "off",
        ),
      ).toBe("low");
    },
  );
});
