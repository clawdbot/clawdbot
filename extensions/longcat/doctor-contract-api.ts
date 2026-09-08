// LongCat doctor contract repairs the historical stock model price persisted
// by onboarding. Match the complete stock row so operator-customized models
// and prices are never rewritten when the vendor catalog changes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const MODELS_PATH = ["models", "providers", "longcat", "models"];
const LEGACY_CACHE_WRITE_PRICE = 0.75;

function isStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function isLegacyStockLongCatModel(value: unknown): boolean {
  const model = asObjectRecord(value);
  const cost = asObjectRecord(model?.cost);
  const compatValue = model?.compat;
  const compat = asObjectRecord(compatValue);
  // Core Doctor removes catalog-owned compat fields before plugin repairs run.
  // Accept that normalized shape, but preserve rows with any divergent compat override.
  const hasHistoricalCompat =
    compatValue === undefined ||
    Boolean(
      compat &&
      compat.supportsStore === false &&
      compat.supportsDeveloperRole === false &&
      compat.supportsReasoningEffort === false &&
      compat.supportsUsageInStreaming === false &&
      compat.supportsStrictMode === false &&
      compat.maxTokensField === "max_tokens" &&
      compat.requiresReasoningContentOnAssistantMessages === true &&
      compat.thinkingFormat === "deepseek" &&
      Object.keys(compat).length === 8,
    );
  return Boolean(
    model &&
    model.id === "LongCat-2.0" &&
    model.name === "LongCat 2.0" &&
    model.reasoning === true &&
    isStringArray(model.input, ["text"]) &&
    model.contextWindow === 1_048_576 &&
    model.maxTokens === 131_072 &&
    cost?.input === 0.75 &&
    cost.output === 2.95 &&
    cost.cacheRead === 0.015 &&
    cost.cacheWrite === LEGACY_CACHE_WRITE_PRICE &&
    hasHistoricalCompat,
  );
}

function hasLegacyStockLongCatModel(value: unknown): boolean {
  return Array.isArray(value) && value.some(isLegacyStockLongCatModel);
}

export const legacyConfigRules = [
  {
    path: MODELS_PATH,
    message:
      'models.providers.longcat.models contains the historical stock LongCat-2.0 cache-write price; run "openclaw doctor --fix" to update it without changing customized rows.',
    match: hasLegacyStockLongCatModel,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const models = cfg.models;
  const providers = models?.providers;
  const provider = providers?.longcat;
  const configuredModels = provider?.models;
  if (
    !provider ||
    !hasLegacyStockLongCatModel(configuredModels) ||
    !Array.isArray(configuredModels)
  ) {
    return { config: cfg, changes: [] };
  }

  const nextModels = configuredModels.map((model) => {
    if (!isLegacyStockLongCatModel(model)) {
      return model;
    }
    return Object.assign({}, model, {
      cost: Object.assign({}, model.cost, { cacheWrite: 0 }),
    });
  });

  return {
    config: {
      ...cfg,
      models: {
        ...models,
        providers: {
          ...providers,
          longcat: { ...provider, models: nextModels },
        },
      },
    },
    changes: ["Updated the historical stock LongCat-2.0 cache-write price from $0.75 to $0."],
  };
}
