import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("deepseek provider-policy-api", () => {
  it("hydrates contextWindow and cost from catalog for known models", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(result).not.toBe(providerConfig);
    const model = result.models[0];
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.028,
      cacheWrite: 0,
    });
  });

  it("hydrates deepseek-v4-pro with correct metadata", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    const model = result.models[0];
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.cost).toEqual({
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
      cacheWrite: 0,
    });
  });

  it("hydrates deepseek-chat with 131k context", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    const model = result.models[0];
    expect(model.contextWindow).toBe(131_072);
  });

  it("preserves explicit user contextWindow override", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 500_000,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    const model = result.models[0];
    expect(model.contextWindow).toBe(500_000);
    // cost should still be hydrated since it was missing
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.028,
      cacheWrite: 0,
    });
  });

  it("preserves explicit user cost override", () => {
    const userCost = { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          cost: userCost,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    const model = result.models[0];
    expect(model.cost).toEqual(userCost);
    // contextWindow should still be hydrated since it was missing
    expect(model.contextWindow).toBe(1_000_000);
  });

  it("preserves explicit user maxTokens override", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          maxTokens: 100_000,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    const model = result.models[0];
    expect(model.maxTokens).toBe(100_000);
  });

  it("returns providerConfig unchanged when all models already have metadata", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result).toBe(providerConfig);
  });

  it("passes through unknown model ids unchanged", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-custom-finetune",
          name: "Custom Fine-tune",
          reasoning: false,
          input: ["text"],
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result).toBe(providerConfig);
  });

  it("returns providerConfig unchanged when models array is empty", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result).toBe(providerConfig);
  });

  it("hydrates only the models that need it in a mixed list", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
        } as never,
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });
    expect(result).not.toBe(providerConfig);
    // First model should be unchanged (same reference)
    expect(result.models[0]).toBe(providerConfig.models[0]);
    // Second model should be hydrated
    expect(result.models[1].contextWindow).toBe(1_000_000);
    expect(result.models[1].cost).toEqual({
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
      cacheWrite: 0,
    });
  });
});
