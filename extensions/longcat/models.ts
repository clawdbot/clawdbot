// LongCat plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const LONGCAT_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "longcat",
  catalog: manifest.modelCatalog.providers.longcat,
});

export const LONGCAT_BASE_URL = LONGCAT_MANIFEST_PROVIDER.baseUrl;
export const LONGCAT_MODEL_CATALOG: ModelDefinitionConfig[] = LONGCAT_MANIFEST_PROVIDER.models;
export const LONGCAT_DEFAULT_MODEL_ID = "LongCat-2.0";
export const LONGCAT_DEFAULT_MODEL_REF = `longcat/${LONGCAT_DEFAULT_MODEL_ID}`;
