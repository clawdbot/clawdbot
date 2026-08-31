// Deepseek API module exposes the plugin public contract.
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { DEEPSEEK_MODEL_CATALOG } from "./models.js";
import { resolveDeepSeekV4ThinkingProfile } from "./thinking.js";

type ModelDefinitionDraft = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

type CatalogMetadataSnapshot = Pick<ModelDefinitionConfig, "contextWindow" | "cost" | "maxTokens">;

// Onboarding wrote these catalog-owned values into user config in prior releases.
// Refresh only exact matches; any other values remain explicit user overrides.
const PREVIOUS_BUNDLED_METADATA: Record<string, CatalogMetadataSnapshot> = {
  "deepseek-v4-flash": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  "deepseek-chat": {
    contextWindow: 131_072,
    maxTokens: 8_192,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
  "deepseek-reasoner": {
    contextWindow: 131_072,
    maxTokens: 65_536,
    cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  },
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Build a lookup from the bundled DeepSeek model catalog so we can hydrate
 * missing metadata (contextWindow, cost, maxTokens) into user-configured
 * model rows without overwriting explicit overrides.
 */
function buildCatalogIndex(): Map<string, ModelDefinitionConfig> {
  const index = new Map<string, ModelDefinitionConfig>();
  for (const model of DEEPSEEK_MODEL_CATALOG) {
    index.set(model.id, model);
  }
  return index;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasCostValues(cost: unknown): cost is ModelDefinitionConfig["cost"] {
  if (!cost || typeof cost !== "object") {
    return false;
  }
  const c = cost as Record<string, unknown>;
  return (
    typeof c.input === "number" ||
    typeof c.output === "number" ||
    typeof c.cacheRead === "number" ||
    typeof c.cacheWrite === "number"
  );
}

function hasSameCost(left: unknown, right: ModelDefinitionConfig["cost"] | undefined): boolean {
  if (!left || typeof left !== "object" || !right) {
    return false;
  }
  const cost = left as Record<string, unknown>;
  if (Object.hasOwn(cost, "tieredPricing")) {
    return false;
  }
  return (
    cost.input === right.input &&
    cost.output === right.output &&
    cost.cacheRead === right.cacheRead &&
    cost.cacheWrite === right.cacheWrite
  );
}

function isShippedZeroCostAliasSnapshot(
  raw: ModelDefinitionDraft,
  previous: CatalogMetadataSnapshot | undefined,
): boolean {
  return (
    (raw.id === "deepseek-chat" || raw.id === "deepseek-reasoner") &&
    raw.contextWindow === previous?.contextWindow &&
    raw.maxTokens === previous?.maxTokens &&
    hasSameCost(raw.cost, ZERO_COST)
  );
}

function isPreviousBundledMetadataSnapshot(
  raw: ModelDefinitionDraft,
  previous: CatalogMetadataSnapshot | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  return (
    raw.contextWindow === previous.contextWindow &&
    raw.maxTokens === previous.maxTokens &&
    (hasSameCost(raw.cost, previous.cost) || isShippedZeroCostAliasSnapshot(raw, previous))
  );
}

/**
 * Provider policy surface for DeepSeek.
 *
 * Hydrates missing `contextWindow`, `cost`, and `maxTokens` from the bundled
 * catalog for matching model ids. Explicit user overrides are preserved.
 */
export function normalizeConfig(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
}): ModelProviderConfig {
  const { providerConfig } = params;
  if (!Array.isArray(providerConfig.models) || providerConfig.models.length === 0) {
    return providerConfig;
  }

  const catalog = buildCatalogIndex();
  let mutated = false;

  const nextModels = providerConfig.models.map((model) => {
    const raw = model as ModelDefinitionDraft;
    const catalogEntry = catalog.get(raw.id);
    if (!catalogEntry) {
      return model;
    }
    const previousEntry = PREVIOUS_BUNDLED_METADATA[raw.id];
    const hasPreviousBundledMetadata = isPreviousBundledMetadataSnapshot(raw, previousEntry);

    let modelMutated = false;
    const patched: Record<string, unknown> = {};

    // Refresh only whole snapshots written by prior releases. A partial match can
    // be an intentional user cap, so per-field refresh would silently erase it.
    if (
      (!isPositiveNumber(raw.contextWindow) ||
        (hasPreviousBundledMetadata && raw.contextWindow !== catalogEntry.contextWindow)) &&
      isPositiveNumber(catalogEntry.contextWindow)
    ) {
      patched.contextWindow = catalogEntry.contextWindow;
      modelMutated = true;
    }

    // Hydrate maxTokens from catalog when missing or not a positive number.
    if (
      (!isPositiveNumber(raw.maxTokens) ||
        (hasPreviousBundledMetadata && raw.maxTokens !== catalogEntry.maxTokens)) &&
      isPositiveNumber(catalogEntry.maxTokens)
    ) {
      patched.maxTokens = catalogEntry.maxTokens;
      modelMutated = true;
    }

    // Hydrate missing cost or refresh a known catalog-owned snapshot from a prior release.
    if (
      (!hasCostValues(raw.cost) || hasPreviousBundledMetadata) &&
      hasCostValues(catalogEntry.cost) &&
      !hasSameCost(raw.cost, catalogEntry.cost)
    ) {
      patched.cost = catalogEntry.cost;
      modelMutated = true;
    }

    if (!modelMutated) {
      return model;
    }

    mutated = true;
    return { ...raw, ...patched };
  });

  if (!mutated) {
    return providerConfig;
  }

  return { ...providerConfig, models: nextModels as ModelDefinitionConfig[] };
}

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  return params.provider.trim().toLowerCase() === "deepseek"
    ? resolveDeepSeekV4ThinkingProfile(params.modelId)
    : null;
}
