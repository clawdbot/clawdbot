// Volcengine plugin module implements models behavior.
import { buildManifestProviderCatalogFamily } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const VOLCENGINE_PROVIDER_CATALOG = buildManifestProviderCatalogFamily({
  surfaces: [
    {
      id: "volcengine",
      label: "Volcengine",
      catalog: manifest.modelCatalog.providers.volcengine,
    },
    {
      id: "volcengine-plan",
      label: "Volcengine Plan",
      catalog: manifest.modelCatalog.providers["volcengine-plan"],
    },
  ],
});

const DOUBAO_PROVIDER = VOLCENGINE_PROVIDER_CATALOG.entries[0]!;
const DOUBAO_CODING_PROVIDER = VOLCENGINE_PROVIDER_CATALOG.entries[1]!;

export const DOUBAO_BASE_URL = DOUBAO_PROVIDER.baseUrl;
export const DOUBAO_CODING_BASE_URL = DOUBAO_CODING_PROVIDER.baseUrl;

export const DOUBAO_MODEL_CATALOG = DOUBAO_PROVIDER.models;
export const DOUBAO_CODING_MODEL_CATALOG = DOUBAO_CODING_PROVIDER.models;
