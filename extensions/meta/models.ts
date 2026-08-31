/**
 * Meta model catalog helpers derived from the plugin manifest.
 */
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildMetaProvider } from "./provider-catalog.js";

const META_MANIFEST_CATALOG = manifest.modelCatalog.providers["meta"];

/** Base URL for Meta OpenAI-compatible inference. */
export const META_BASE_URL = META_MANIFEST_CATALOG.baseUrl;
/** Meta model catalog entries from the plugin manifest. */
export const META_MODEL_CATALOG = META_MANIFEST_CATALOG.models;

/** Builds normalized Meta catalog model definitions. */
export function buildMetaCatalogModels(): ModelDefinitionConfig[] {
  return buildMetaProvider().models;
}
