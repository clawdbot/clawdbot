// Xai setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildXaiCatalogModels,
  isLegacyXaiBuiltinModel,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
} from "./model-definitions.js";
import { XAI_OAUTH_AUTO_MODEL_ID } from "./model-id.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
// OAuth resolves this stable ref against xAI's authenticated catalog and
// remote default setting. API-key setup stays on the pinned default above.
export const XAI_OAUTH_DEFAULT_MODEL_REF = `xai/${XAI_OAUTH_AUTO_MODEL_ID}`;

function createXaiPresetAppliers(primaryModelRef: string) {
  return createModelCatalogPresetAppliers<["openai-completions" | "openai-responses"]>({
    primaryModelRef,
    resolveParams: (_cfg: OpenClawConfig, api) => ({
      providerId: "xai",
      api,
      baseUrl: XAI_BASE_URL,
      catalogModels: buildXaiCatalogModels(),
      aliases: [{ modelRef: primaryModelRef, alias: "Grok" }],
    }),
  });
}

const xaiPresetAppliers = createXaiPresetAppliers(XAI_DEFAULT_MODEL_REF);
const xaiOAuthPresetAppliers = createXaiPresetAppliers(XAI_OAUTH_DEFAULT_MODEL_REF);

function pruneRetiredXaiBuiltinModels(cfg: OpenClawConfig): OpenClawConfig {
  const provider = cfg.models?.providers?.xai;
  if (!provider || !Array.isArray(provider.models)) {
    return cfg;
  }
  const models = provider.models.filter((model) => !isLegacyXaiBuiltinModel(model));
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

export function applyXaiOAuthConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xaiOAuthPresetAppliers.applyConfig(pruneRetiredXaiBuiltinModels(cfg), "openai-responses");
}
