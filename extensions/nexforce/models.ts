/**
 * Nexforce Router model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelDefinition } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const NEXFORCE_MANIFEST_CATALOG = manifest.modelCatalog.providers.nexforce;

/** Base URL for Nexforce Router OpenAI-compatible inference. */
export const NEXFORCE_BASE_URL = NEXFORCE_MANIFEST_CATALOG.baseUrl;
/** Nexforce Router model catalog entries from the plugin manifest. */
export const NEXFORCE_MODEL_CATALOG = NEXFORCE_MANIFEST_CATALOG.models;

/** Builds normalized Nexforce Router catalog model definitions. */
export function buildNexforceCatalogModels(): ModelDefinitionConfig[] {
  return NEXFORCE_MODEL_CATALOG.map(
    buildManifestModelDefinition({ providerId: "nexforce", catalog: NEXFORCE_MANIFEST_CATALOG }),
  );
}
