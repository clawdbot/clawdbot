import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildCohereCatalogModels, COHERE_BASE_URL } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const COHERE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "cohere")!;

const coherePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: COHERE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "cohere",
    api: "openai-completions",
    baseUrl: COHERE_BASE_URL,
    catalogModels: buildCohereCatalogModels(),
    aliases: [{ modelRef: COHERE_DEFAULT_MODEL_REF, alias: "Cohere Command A+" }],
  }),
});

export function applyCohereConfig(cfg: OpenClawConfig): OpenClawConfig {
  return coherePresetAppliers.applyConfig(cfg);
}
