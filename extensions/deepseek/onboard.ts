import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const DEEPSEEK_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  "deepseek",
)!;

const deepSeekPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: DEEPSEEK_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => ({
    providerId: "deepseek",
    api: "openai-completions",
    baseUrl: DEEPSEEK_BASE_URL,
    catalogModels: structuredClone(DEEPSEEK_MODEL_CATALOG),
    aliases: [{ modelRef: DEEPSEEK_DEFAULT_MODEL_REF, alias: "DeepSeek" }],
  }),
});

export function applyDeepSeekConfig(cfg: OpenClawConfig): OpenClawConfig {
  return deepSeekPresetAppliers.applyConfig(cfg);
}
