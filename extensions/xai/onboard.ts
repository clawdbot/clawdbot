import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { XAI_BASE_URL, XAI_DEFAULT_MODEL_ID } from "./model-definitions.js";
import { buildXaiCatalogModels, isRetiredXaiBuiltinModelId } from "./model-definitions.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;

const xaiPresetAppliers = createModelCatalogPresetAppliers<
  ["openai-completions" | "openai-responses"]
>({
  primaryModelRef: XAI_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig, api) => ({
    providerId: "xai",
    api,
    baseUrl: XAI_BASE_URL,
    catalogModels: buildXaiCatalogModels(),
    aliases: [{ modelRef: XAI_DEFAULT_MODEL_REF, alias: "Grok" }],
  }),
});

function pruneRetiredXaiBuiltinModels(cfg: OpenClawConfig): OpenClawConfig {
  const provider = cfg.models?.providers?.xai;
  if (!provider || !Array.isArray(provider.models)) {
    return cfg;
  }
  const models = provider.models.filter((model) => !isRetiredXaiBuiltinModelId(model.id));
  if (models.length === provider.models.length) {
    return cfg;
  }
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        xai: {
          ...provider,
          models,
        },
      },
    },
  };
}

export function applyXaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xaiPresetAppliers.applyProviderConfig(
    pruneRetiredXaiBuiltinModels(cfg),
    "openai-responses",
  );
}

export function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xaiPresetAppliers.applyConfig(pruneRetiredXaiBuiltinModels(cfg), "openai-responses");
}
