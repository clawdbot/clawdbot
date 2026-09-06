// Ollama tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { createModel } from "./model.test-support.js";
import {
  normalizeConfig,
  projectConfiguredModelRow,
  resolveThinkingProfile,
  resolveToolSearchMode,
} from "./provider-policy-api.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";

describe("ollama provider policy public artifact", () => {
  it.each([
    {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      expected: "tools",
    },
    {
      provider: "ollama",
      modelId: "qwen3.5:9b",
      baseUrl: "http://model-host.internal:11434",
      expected: "tools",
    },
    {
      provider: "ollama",
      modelId: "untagged-server-alias",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      expected: "tools",
    },
    {
      provider: "OLLAMA",
      modelId: "kimi-k2.5:cloud",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      expected: false,
    },
    {
      provider: "ollama",
      modelId: "gpt-oss:120b-cloud",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      expected: false,
    },
    {
      provider: "ollama-cloud",
      modelId: "kimi-k2.5",
      baseUrl: OLLAMA_DEFAULT_BASE_URL,
      expected: false,
    },
    { provider: "ollama", modelId: "kimi-k2.5", baseUrl: "https://ollama.com/v1", expected: false },
  ])("selects Tool Search for $provider/$modelId at $baseUrl", ({ expected, ...context }) => {
    expect(resolveToolSearchMode({ ...context, api: "ollama" })).toBe(expected);
  });
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
          ...createModel("qwen3.5:9b", "Qwen 3.5 9B", { reasoning: true }),
          provider: provider.trim().toLowerCase(),
          api: "ollama",
          baseUrl: OLLAMA_DEFAULT_BASE_URL,
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
          ...createModel("gpt-5.5", "GPT-5.5", { reasoning: true }),
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toBeUndefined();
  });

  it("exposes every native effort for reasoning-capable models without full plugin activation", () => {
    expect(
      resolveThinkingProfile({ provider: "ollama", modelId: "qwen3:32b", reasoning: true }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
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
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "max" },
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
