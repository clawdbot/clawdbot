// Volcengine provider module implements model/runtime integration.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { DOUBAO_CODING_MODEL_CATALOG, DOUBAO_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export function buildDoubaoProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "volcengine",
    catalog: manifest.modelCatalog.providers.volcengine,
  });
}

export function buildDoubaoCodingProvider(): ModelProviderConfig {
  return buildManifestModelProviderConfig({
    providerId: "volcengine-plan",
    catalog: manifest.modelCatalog.providers["volcengine-plan"],
  });
}

export const VOLCENGINE_PROVIDER_CATALOG_ENTRIES = [
  {
    id: "volcengine",
    label: "Volcengine",
    models: DOUBAO_MODEL_CATALOG,
    buildProvider: buildDoubaoProvider,
  },
  {
    id: "volcengine-plan",
    label: "Volcengine Plan",
    models: DOUBAO_CODING_MODEL_CATALOG,
    buildProvider: buildDoubaoCodingProvider,
  },
] as const;
