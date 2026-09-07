// Xai setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  applyOnboardAuthAgentModelsAndProviders,
  createModelCatalogPresetAppliers,
  resolveAgentModelPrimaryValue,
  withAgentModelAliases,
  type ModelProviderConfig,
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

const xaiPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: XAI_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "xai",
    api: "openai-responses",
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
  return xaiPresetAppliers.applyProviderConfig(pruneRetiredXaiBuiltinModels(cfg));
}

export function applyXaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return xaiPresetAppliers.applyConfig(pruneRetiredXaiBuiltinModels(cfg));
}

export function applyXaiOAuthConfig(
  cfg: OpenClawConfig,
  provider: ModelProviderConfig,
): OpenClawConfig {
  const next = applyOnboardAuthAgentModelsAndProviders(cfg, {
    agentModels: withAgentModelAliases(cfg.agents?.defaults?.models, [
      { modelRef: XAI_OAUTH_DEFAULT_MODEL_REF, alias: "Grok" },
    ]),
    providers: {
      xai: {
        ...provider,
        apiKey: undefined,
        authHeader: undefined,
        headers: undefined,
        request: { auth: undefined, headers: undefined },
        // The moving alias must come from discovery, never a persisted target.
        models: provider.models.filter((model) => model.id !== XAI_OAUTH_AUTO_MODEL_ID),
      },
    },
  });
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)
    ? next
    : applyAgentDefaultModelPrimary(next, XAI_OAUTH_DEFAULT_MODEL_REF);
}
