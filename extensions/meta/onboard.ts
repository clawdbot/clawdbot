/**
 * Meta onboarding config helpers.
 */
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildMetaCatalogModels, META_BASE_URL } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

/** Default Meta model reference used after onboarding. */
export const META_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "meta")!;

const metaPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: META_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "meta",
    api: "openai-responses",
    baseUrl: META_BASE_URL,
    catalogModels: buildMetaCatalogModels(),
    aliases: [{ modelRef: META_DEFAULT_MODEL_REF, alias: "Muse Spark 1.1" }],
  }),
});

/** Applies Meta provider/catalog config and default model aliases. */
export function applyMetaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return metaPresetAppliers.applyConfig(cfg);
}
