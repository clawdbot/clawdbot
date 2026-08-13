import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
    ...overrides,
  };
}

describe("readAgentModelContextTokens", () => {
  it("returns contextTokens when present", () => {
    const model = makeModel({ contextTokens: 4096, contextWindow: 8192 });
    expect(readAgentModelContextTokens(model)).toBe(4096);
  });

  it("falls back to contextWindow when contextTokens is absent", () => {
    const model = makeModel({ contextWindow: 8192 });
    expect(readAgentModelContextTokens(model)).toBe(8192);
  });

  it("prefers contextTokens over contextWindow when both are present", () => {
    const model = makeModel({ contextTokens: 4096, contextWindow: 8192 });
    expect(readAgentModelContextTokens(model)).toBe(4096);
  });

  it("returns undefined when model is null or undefined", () => {
    expect(readAgentModelContextTokens(null)).toBeUndefined();
    expect(readAgentModelContextTokens(undefined)).toBeUndefined();
  });
});
