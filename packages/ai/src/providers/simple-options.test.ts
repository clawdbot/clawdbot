import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildBaseOptions, clampMaxTokensToModel } from "./simple-options.js";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 9_000,
    ...overrides,
  };
}

describe("simple stream max-token clamp", () => {
  it("leaves a request below the model output limit unchanged", () => {
    expect(clampMaxTokensToModel(makeModel(), 512)).toBe(512);
  });

  it("clamps an excessive request to the model output limit", () => {
    expect(clampMaxTokensToModel(makeModel(), 90_000)).toBe(9_000);
  });

  it("keeps a valid floor for a non-positive request", () => {
    expect(clampMaxTokensToModel(makeModel(), 0)).toBe(1);
  });

  it("preserves an omitted output limit", () => {
    expect(clampMaxTokensToModel(makeModel(), undefined)).toBeUndefined();
    expect(buildBaseOptions(makeModel()).maxTokens).toBeUndefined();
  });
});
