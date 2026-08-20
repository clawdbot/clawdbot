// LongCat tests cover the plugin-owned persisted catalog repair.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const LEGACY_STOCK_MODEL = {
  id: "LongCat-2.0",
  name: "LongCat 2.0",
  reasoning: true,
  input: ["text"],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 0.75, output: 2.95, cacheRead: 0.015, cacheWrite: 0.75 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: "max_tokens",
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: "deepseek",
  },
};

function longcatConfig(models: unknown[]): OpenClawConfig {
  return {
    models: {
      providers: {
        longcat: {
          baseUrl: "https://api.longcat.chat/openai",
          api: "openai-completions",
          models,
        },
      },
    },
  } as OpenClawConfig;
}

describe("LongCat doctor contract", () => {
  it("repairs only the exact historical stock row", () => {
    const custom = {
      ...LEGACY_STOCK_MODEL,
      name: "My LongCat",
      cost: { ...LEGACY_STOCK_MODEL.cost },
    };
    const other = { id: "custom-model", name: "Custom" };
    const config = longcatConfig([structuredClone(LEGACY_STOCK_MODEL), custom, other]);

    expect(legacyConfigRules[0]?.match?.(config.models?.providers?.longcat?.models)).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg: config });
    expect(result.changes).toEqual([
      "Updated the historical stock LongCat-2.0 cache-write price from $0.75 to $0.",
    ]);
    expect(result.config.models?.providers?.longcat?.models).toEqual([
      {
        ...LEGACY_STOCK_MODEL,
        cost: { ...LEGACY_STOCK_MODEL.cost, cacheWrite: 0 },
      },
      custom,
      other,
    ]);
    expect(config.models?.providers?.longcat?.models?.[0]?.cost.cacheWrite).toBe(0.75);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("repairs the historical row after core Doctor removes catalog-owned compat", () => {
    const { compat: _compat, ...normalizedLegacyStockModel } = LEGACY_STOCK_MODEL;
    const custom = {
      ...normalizedLegacyStockModel,
      compat: { supportsStore: true },
    };
    const config = longcatConfig([normalizedLegacyStockModel, custom]);

    const result = normalizeCompatibilityConfig({ cfg: config });
    expect(result.config.models?.providers?.longcat?.models).toEqual([
      {
        ...normalizedLegacyStockModel,
        cost: { ...normalizedLegacyStockModel.cost, cacheWrite: 0 },
      },
      custom,
    ]);
  });

  it("preserves customized prices and already-correct rows", () => {
    for (const cacheWrite of [0, 0.5]) {
      const model = {
        ...LEGACY_STOCK_MODEL,
        cost: { ...LEGACY_STOCK_MODEL.cost, cacheWrite },
      };
      const config = longcatConfig([model]);
      expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
    }
  });
});
