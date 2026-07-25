/**
 * Cerebras model catalog helpers derived from the plugin manifest.
 */
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const CEREBRAS_MANIFEST_CATALOG = manifest.modelCatalog.providers.cerebras;

/** Base URL for Cerebras OpenAI-compatible inference. */
export const CEREBRAS_BASE_URL = CEREBRAS_MANIFEST_CATALOG.baseUrl;
/** Cerebras model catalog entries from the plugin manifest. */
export const CEREBRAS_MODEL_CATALOG = CEREBRAS_MANIFEST_CATALOG.models;

/** Builds normalized Cerebras catalog model definitions. */
export function buildCerebrasCatalogModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: CEREBRAS_MANIFEST_CATALOG,
  }).models;
}

/** Builds one normalized Cerebras model definition from a manifest entry. */
export function buildCerebrasModelDefinition(
  model: (typeof CEREBRAS_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  const providerConfig = buildManifestModelProviderConfig({
    providerId: "cerebras",
    catalog: { ...CEREBRAS_MANIFEST_CATALOG, models: [model] },
  });
  return expectDefined(providerConfig.models.at(0), "normalized Cerebras manifest model");
}
