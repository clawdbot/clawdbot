import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "deepseek")!;

export const { applyConfig: applyDeepSeekConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: DEEPSEEK_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => ({
    providerId: "deepseek",
    api: "openai-completions",
    baseUrl: DEEPSEEK_BASE_URL,
    catalogModels: cfg.models?.mode === "replace" ? structuredClone(DEEPSEEK_MODEL_CATALOG) : [],
    aliases: [{ modelRef: DEEPSEEK_DEFAULT_MODEL_REF, alias: "DeepSeek" }],
  }),
});
