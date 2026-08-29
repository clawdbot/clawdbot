// Ollama tests cover provider policy api plugin behavior.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import {
  normalizeConfig,
  projectConfiguredModelRow,
  resolveThinkingProfile,
} from "./provider-policy-api.js";
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

// Reasoning-capable Ollama models expose the same native effort tiers, including
// the OpenClaw-only `adaptive` tier mapped to Ollama high effort.
const OLLAMA_FULL_REASONING_LEVELS = [
  { id: "off" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "adaptive" },
  { id: "max" },
] as const;

describe("ollama provider policy public artifact", () => {
  it("injects defaults so implicit discovery can run before validation", () => {
    expect(
      normalizeConfig({
        provider: "ollama",
        providerConfig: {},
      }),
    ).toStrictEqual({
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
    ).toStrictEqual({
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
    ).toStrictEqual({});
  });

  it.each(["ollama", " OLLAMA-CLOUD "])("skips runtime row normalization for %s", (provider) => {
    expect(
      projectConfiguredModelRow({
        provider,
        modelId: "qwen3.5:9b",
        model: {
          provider: provider.trim().toLowerCase(),
          id: "qwen3.5:9b",
          api: "ollama",
          baseUrl: OLLAMA_DEFAULT_BASE_URL,
          input: ["text"],
          name: "Qwen 3.5 9B",
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      }),
    ).toBeNull();
  });

  it("keeps unrelated providers on the runtime normalization path", () => {
    expect(
      projectConfiguredModelRow({
        provider: "openai",
        modelId: "gpt-5.5",
        model: {
          provider: "openai",
          id: "gpt-5.5",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          input: ["text"],
          name: "GPT-5.5",
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8_192,
        },
      }),
    ).toBeUndefined();
  });

  it("exposes every native effort for reasoning-capable models without full plugin activation", () => {
    expect(
      resolveThinkingProfile({ provider: "ollama", modelId: "qwen3:32b", reasoning: true }),
    ).toEqual({
      levels: [...OLLAMA_FULL_REASONING_LEVELS],
      defaultLevel: "off",
    });
    expect(
      resolveThinkingProfile({ provider: "ollama", modelId: "llama3.2", reasoning: false }),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it.each(["glm-5.2", "deepseek-v4-pro:cloud"])(
    "exposes full native effort for cloud model %s when lightweight projections omit metadata",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "ollama-cloud", modelId }).levels).toEqual([
        ...OLLAMA_FULL_REASONING_LEVELS,
      ]);
    },
  );

  it.each(["minimax-m2.7", "glm-5.1", "kimi-k2.5", "custom-thinking-model"])(
    "does not invent effort levels for catalog-light cloud model %s",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "ollama-cloud", modelId }).levels).toEqual([
        { id: "off" },
      ]);
    },
  );

  it("keeps explicit non-reasoning metadata authoritative for known cloud model ids", () => {
    expect(
      resolveThinkingProfile({
        provider: "ollama-cloud",
        modelId: "glm-5.2",
        reasoning: false,
      }).levels,
    ).toEqual([{ id: "off" }]);
  });

  it("does not infer thinking support for unknown models without catalog metadata", () => {
    expect(resolveThinkingProfile({ provider: "ollama", modelId: "llama3.2" }).levels).toEqual([
      { id: "off" },
    ]);
  });

  it("does not apply cloud catalog facts to an unqualified local model", () => {
    expect(resolveThinkingProfile({ provider: "ollama", modelId: "glm-5.2" }).levels).toEqual([
      { id: "off" },
    ]);
  });
});
