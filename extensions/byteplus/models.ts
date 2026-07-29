/**
 * BytePlus model catalog helpers derived from the plugin manifest.
 */
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const BYTEPLUS_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "byteplus",
  catalog: manifest.modelCatalog.providers.byteplus,
});

const BYTEPLUS_CODING_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "byteplus-plan",
  catalog: manifest.modelCatalog.providers["byteplus-plan"],
});

/** Base URL for BytePlus chat/model APIs from the manifest catalog. */
export const BYTEPLUS_BASE_URL = BYTEPLUS_MANIFEST_PROVIDER.baseUrl;
/** Base URL for BytePlus Plan coding APIs from the manifest catalog. */
export const BYTEPLUS_CODING_BASE_URL = BYTEPLUS_CODING_MANIFEST_PROVIDER.baseUrl;

/** BytePlus general model catalog entries. */
export const BYTEPLUS_MODEL_CATALOG: ModelDefinitionConfig[] = BYTEPLUS_MANIFEST_PROVIDER.models;
/** BytePlus coding/planning model catalog entries. */
export const BYTEPLUS_CODING_MODEL_CATALOG: ModelDefinitionConfig[] =
  BYTEPLUS_CODING_MANIFEST_PROVIDER.models;
