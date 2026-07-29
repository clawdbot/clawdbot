/**
 * BytePlus model provider builders backed by the plugin manifest catalog.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { BYTEPLUS_CODING_MODEL_CATALOG, BYTEPLUS_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

/** Builds the standard BytePlus model provider config. */
export function buildBytePlusProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "byteplus",
    catalog: manifest.modelCatalog.providers.byteplus,
  });
}

/** Builds the BytePlus Plan coding-provider config. */
export function buildBytePlusCodingProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "byteplus-plan",
    catalog: manifest.modelCatalog.providers["byteplus-plan"],
  });
}

export const BYTEPLUS_PROVIDER_CATALOG_ENTRIES = [
  {
    id: "byteplus",
    label: "BytePlus",
    models: BYTEPLUS_MODEL_CATALOG,
    buildProvider: buildBytePlusProvider,
  },
  {
    id: "byteplus-plan",
    label: "BytePlus Plan",
    models: BYTEPLUS_CODING_MODEL_CATALOG,
    buildProvider: buildBytePlusCodingProvider,
  },
] as const;
