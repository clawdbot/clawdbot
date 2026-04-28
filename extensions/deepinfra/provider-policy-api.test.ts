import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

function createModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("deepinfra provider policy public artifact", () => {
  it("preserves the DeepInfra mid-path /v1 baseUrl without appending another /v1", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepinfra.com/v1/openai",
      api: "openai-completions",
      models: [createModel("zai-org/GLM-5")],
    };

    const normalized = normalizeConfig({ provider: "deepinfra", providerConfig });

    expect(normalized.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
    expect(normalized.baseUrl).not.toMatch(/\/v1\/openai\/v1$/);
  });

  it("returns the providerConfig unchanged (referentially equal)", () => {
    const providerConfig = {
      baseUrl: "https://api.deepinfra.com/v1/openai",
      models: [],
    };
    expect(normalizeConfig({ provider: "deepinfra", providerConfig })).toBe(providerConfig);
  });
});
