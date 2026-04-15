import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { buildKilocodeProvider } from "./provider-catalog.js";
import { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF } from "./provider-models.js";

export { KILOCODE_BASE_URL, KILOCODE_DEFAULT_MODEL_REF };

const kilocodePresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: KILOCODE_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "kilocode",
    api: "openai-completions",
    baseUrl: KILOCODE_BASE_URL,
    catalogModels: buildKilocodeProvider().models ?? [],
    aliases: [{ modelRef: KILOCODE_DEFAULT_MODEL_REF, alias: "Kilo Gateway" }],
  }),
});

export function applyKilocodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kilocodePresetAppliers.applyProviderConfig(cfg);
}

export function applyKilocodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kilocodePresetAppliers.applyConfig(cfg);
}
