/**
 * Meta onboarding config helpers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildMetaModelDefinition, META_BASE_URL, META_MODEL_CATALOG } from "./models.js";

/** Default Meta model reference used after onboarding. */
export const META_DEFAULT_MODEL_REF = "meta/muse-spark-1.1";

const metaPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: META_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "meta",
    api: "openai-responses",
    baseUrl: META_BASE_URL,
    catalogModels: META_MODEL_CATALOG.map(buildMetaModelDefinition),
    aliases: [{ modelRef: META_DEFAULT_MODEL_REF, alias: "Muse Spark 1.1" }],
  }),
});

/** Applies Meta provider/catalog config and default model aliases. */
export function applyMetaConfig(cfg: OpenClawConfig): OpenClawConfig {
  return metaPresetAppliers.applyConfig(cfg);
}
