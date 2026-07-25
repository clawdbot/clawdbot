// Deepseek tests cover provider policy api plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";

function requireModel(config: ModelProviderConfig, index: number) {
  return expectDefined(config.models[index], `DeepSeek provider model ${index}`);
}

describe("deepseek provider-policy-api", () => {
  it("advertises max thinking levels for DeepSeek V4 models", () => {
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
      })?.levels.map((level) => level.id),
    ).toEqual(expectedV4Levels);
    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
      })?.defaultLevel,
    ).toBe("high");
    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-chat",
      }),
    ).toBe(undefined);
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "deepseek-v4-pro",
      }),
    ).toBe(null);
  });

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
    const model = requireModel(result, 0);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
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
    const model = requireModel(result, 0);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.cost).toEqual({
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    });
  });

  it("hydrates the legacy chat alias with current V4 Flash metadata", () => {
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
    const model = requireModel(result, 0);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    });
  });

  it("refreshes exact catalog metadata snapshots written by prior releases", () => {
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
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
        },
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
          contextWindow: 131_072,
          maxTokens: 8_192,
          cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
        },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek Reasoner",
          reasoning: true,
          input: ["text"],
          contextWindow: 131_072,
          maxTokens: 65_536,
          cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
        },
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(
      result.models.map(({ id, contextWindow, maxTokens, cost }) => ({
        id,
        contextWindow,
        maxTokens,
        cost,
      })),
    ).toEqual([
      {
        id: "deepseek-v4-flash",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-pro",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
      },
      {
        id: "deepseek-chat",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      },
      {
        id: "deepseek-reasoner",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      },
    ]);
  });

  it("refreshes exact zero-cost legacy alias rows written by tagged releases", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
          contextWindow: 131_072,
          maxTokens: 8_192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "deepseek-reasoner",
          name: "DeepSeek Reasoner",
          reasoning: true,
          input: ["text"],
          contextWindow: 131_072,
          maxTokens: 65_536,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    for (const model of result.models) {
      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxTokens).toBe(384_000);
      expect(model.cost).toEqual({
        input: 0.14,
        output: 0.28,
        cacheRead: 0.0028,
        cacheWrite: 0,
      });
    }
  });

  it("preserves legacy alias metadata when any catalog-owned field is customized", () => {
    const userCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
          contextWindow: 500_000,
          maxTokens: 8_192,
          cost: userCost,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(requireModel(result, 0).contextWindow).toBe(500_000);
    expect(requireModel(result, 0).maxTokens).toBe(8_192);
    expect(requireModel(result, 0).cost).toBe(userCost);
  });

  it("preserves an old maxTokens value when another field makes the row user-owned", () => {
    const userCost = { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
          contextWindow: 500_000,
          maxTokens: 8_192,
          cost: userCost,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(result).toBe(providerConfig);
    expect(requireModel(result, 0)).toMatchObject({ contextWindow: 500_000, maxTokens: 8_192 });
    expect(requireModel(result, 0).cost).toBe(userCost);
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
    const model = requireModel(result, 0);
    expect(model.contextWindow).toBe(500_000);
    // cost should still be hydrated since it was missing
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
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
    const model = requireModel(result, 0);
    expect(model.cost).toEqual(userCost);
    // contextWindow should still be hydrated since it was missing
    expect(model.contextWindow).toBe(1_000_000);
  });

  it("preserves tiered pricing layered onto an older flat catalog snapshot", () => {
    const userCost = {
      input: 1.74,
      output: 3.48,
      cacheRead: 0.145,
      cacheWrite: 0,
      tieredPricing: [
        {
          upTo: 200_000,
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 0,
        },
      ],
    };
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
          cost: userCost,
        } as never,
      ],
    };

    const result = normalizeConfig({ provider: "deepseek", providerConfig });

    expect(requireModel(result, 0).cost).toBe(userCost);
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
    const model = requireModel(result, 0);
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
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
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
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
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
    expect(requireModel(result, 0)).toBe(requireModel(providerConfig, 0));
    // Second model should be hydrated
    expect(requireModel(result, 1).contextWindow).toBe(1_000_000);
    expect(requireModel(result, 1).cost).toEqual({
      input: 0.435,
      output: 0.87,
      cacheRead: 0.003625,
      cacheWrite: 0,
    });
  });
});
