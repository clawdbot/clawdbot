import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";

function createModel(id: string, name: string): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("ollama provider policy public artifact", () => {
  it("injects defaults so implicit discovery can run before validation", () => {
    expect(
      normalizeConfig({
        provider: "ollama",
        providerConfig: {},
      }),
    ).toMatchObject({
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      models: [],
    });
  });

  it("preserves explicit Ollama config values", () => {
    const models = [createModel("llama3.2", "Llama 3.2")];

    expect(
      normalizeConfig({
        provider: "ollama",
        providerConfig: {
          baseUrl: "http://ollama.internal:11434",
          models,
        },
      }),
    ).toMatchObject({
      baseUrl: "http://ollama.internal:11434",
      models,
    });
  });

  it("ignores other providers", () => {
    expect(
      normalizeConfig({
        provider: "openai",
        providerConfig: {},
      }),
    ).toEqual({});
  });

  it("exposes max thinking for reasoning-capable models without full plugin activation", () => {
    expect(resolveThinkingProfile({ reasoning: true })).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
    });
    expect(resolveThinkingProfile({ reasoning: false })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });
});
