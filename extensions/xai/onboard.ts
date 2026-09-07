// Xai setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildXaiCatalogModels,
  buildXaiOAuthCatalogModels,
  isLegacyXaiBuiltinModel,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
} from "./model-definitions.js";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { XAI_GROK_OAUTH_BASE_URL } from "./provider-catalog.js";
import { XAI_OAUTH_AUTO_MODEL_ID } from "./model-id.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
// OAuth resolves this stable ref against xAI's authenticated catalog and
// remote default setting. API-key setup stays on the pinned default above.
export const XAI_OAUTH_DEFAULT_MODEL_REF = `xai/${XAI_OAUTH_AUTO_MODEL_ID}`;

function createXaiPresetAppliers(
  primaryModelRef: string,
  baseUrl: string,
  catalogModels: ModelDefinitionConfig[],
) {
  return createModelCatalogPresetAppliers<["openai-completions" | "openai-responses"]>({
    primaryModelRef,
    resolveParams: (_cfg: OpenClawConfig, api) => ({
      providerId: "xai",
      api,
      baseUrl,
      catalogModels,
      aliases: [{ modelRef: primaryModelRef, alias: "Grok" }],
    }),
  });
}

const xaiPresetAppliers = createXaiPresetAppliers(
  XAI_DEFAULT_MODEL_REF,
  XAI_BASE_URL,
  buildXaiCatalogModels(),
);
// The OAuth preset keeps the subscription proxy transport and the OAuth-only
// catalog (grok-4.6 / grok-4.5). Using the API baseUrl or the API catalog here
// overwrites a working Grok subscription login with unusable API rows (#140482).
const xaiOAuthPresetAppliers = createXaiPresetAppliers(
  XAI_OAUTH_DEFAULT_MODEL_REF,
  XAI_GROK_OAUTH_BASE_URL,
  buildXaiOAuthCatalogModels(),
);

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
