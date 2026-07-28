/**
 * Apiário setup preset appliers.
 */
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { APIARIO_BASE_URL } from "./models.js";
import { buildApiarioCatalogModels } from "./provider-catalog.js";

/** Default Apiário model ref. */
export const APIARIO_DEFAULT_MODEL_REF = "apiario/apiario/default";

const apiarioPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: APIARIO_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "apiario",
    api: "openai-completions",
    baseUrl: APIARIO_BASE_URL,
    catalogModels: buildApiarioCatalogModels(),
    aliases: [{ modelRef: APIARIO_DEFAULT_MODEL_REF, alias: "Apiário" }],
  }),
});

/** Apply Apiário provider defaults to config. */
export function applyApiarioConfig(cfg: OpenClawConfig): OpenClawConfig {
  return apiarioPresetAppliers.applyConfig(cfg);
}
