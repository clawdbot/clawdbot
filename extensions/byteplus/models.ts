/**
 * BytePlus model catalog helpers derived from the plugin manifest.
 */
import { buildManifestProviderCatalogFamily } from "openclaw/plugin-sdk/provider-catalog-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const BYTEPLUS_PROVIDER_CATALOG = buildManifestProviderCatalogFamily({
  surfaces: [
    {
      id: "byteplus",
      label: "BytePlus",
      catalog: manifest.modelCatalog.providers.byteplus,
    },
    {
      id: "byteplus-plan",
      label: "BytePlus Plan",
      catalog: manifest.modelCatalog.providers["byteplus-plan"],
    },
  ],
});

const BYTEPLUS_PROVIDER = BYTEPLUS_PROVIDER_CATALOG.entries[0]!;
const BYTEPLUS_CODING_PROVIDER = BYTEPLUS_PROVIDER_CATALOG.entries[1]!;

/** Base URL for BytePlus chat/model APIs from the manifest catalog. */
export const BYTEPLUS_BASE_URL = BYTEPLUS_PROVIDER.baseUrl;
/** Base URL for BytePlus Plan coding APIs from the manifest catalog. */
export const BYTEPLUS_CODING_BASE_URL = BYTEPLUS_CODING_PROVIDER.baseUrl;

/** BytePlus general model catalog entries. */
export const BYTEPLUS_MODEL_CATALOG = BYTEPLUS_PROVIDER.models;
/** BytePlus coding/planning model catalog entries. */
export const BYTEPLUS_CODING_MODEL_CATALOG = BYTEPLUS_CODING_PROVIDER.models;
