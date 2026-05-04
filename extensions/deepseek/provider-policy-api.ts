import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { DEEPSEEK_MODEL_CATALOG } from "./models.js";
import { resolveDeepSeekV4ThinkingProfile } from "./thinking.js";

type ModelDefinitionDraft = Partial<ModelDefinitionConfig> &
  Pick<ModelDefinitionConfig, "id" | "name">;

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

    let modelMutated = false;
    const patched: Record<string, unknown> = {};

    // Hydrate contextWindow from catalog when missing or not a positive number.
    if (!isPositiveNumber(raw.contextWindow) && isPositiveNumber(catalogEntry.contextWindow)) {
      patched.contextWindow = catalogEntry.contextWindow;
      modelMutated = true;
    }

    // Hydrate maxTokens from catalog when missing or not a positive number.
    if (!isPositiveNumber(raw.maxTokens) && isPositiveNumber(catalogEntry.maxTokens)) {
      patched.maxTokens = catalogEntry.maxTokens;
      modelMutated = true;
    }

    // Hydrate cost from catalog when missing or when all fields are zero/absent.
    if (!hasCostValues(raw.cost) && hasCostValues(catalogEntry.cost)) {
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
