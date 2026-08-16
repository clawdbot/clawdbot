import { describe, expect, it } from "vitest";
import type { Model } from "../../llm/types.js";
import { readAgentModelContextTokens } from "./model-context-tokens.js";

function makeModel(overrides: Partial<Model> & { contextTokens?: number; contextWindow?: number } = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 4096,
    ...overrides,
  } as Model & { contextTokens?: number; contextWindow?: number };
}

describe("readAgentModelContextTokens", () => {
  it("returns contextTokens when present and positive", () => {
    const model = makeModel({ contextTokens: 32000 });
    expect(readAgentModelContextTokens(model)).toBe(32000);
  });

  it("falls back to contextWindow when contextTokens is undefined", () => {
    const model = makeModel({ contextWindow: 64000 });
    expect(readAgentModelContextTokens(model)).toBe(64000);
  });

  it("falls back to contextWindow when contextTokens is 0", () => {
    const model = makeModel({ contextTokens: 0, contextWindow: 64000 });
    expect(readAgentModelContextTokens(model)).toBe(64000);
  });

  it("returns the default when both contextTokens and contextWindow are 0 or undefined", () => {
    expect(readAgentModelContextTokens(makeModel())).toBe(128000);
    expect(readAgentModelContextTokens(makeModel({ contextWindow: 0 }))).toBe(128000);
  });

  it("returns the default for null or undefined model", () => {
    expect(readAgentModelContextTokens(null)).toBe(128000);
    expect(readAgentModelContextTokens(undefined)).toBe(128000);
  });
});
