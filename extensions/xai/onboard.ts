// Xai setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildXaiCatalogModels,
  isLegacyXaiBuiltinModel,
  XAI_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
  XAI_GROK_OAUTH_BASE_URL,
} from "./model-definitions.js";
import { XAI_OAUTH_AUTO_MODEL_ID } from "./model-id.js";

export const XAI_DEFAULT_MODEL_REF = `xai/${XAI_DEFAULT_MODEL_ID}`;
// OAuth resolves this stable ref against xAI's authenticated catalog and
// remote default setting. API-key setup stays on the pinned default above.
export const XAI_OAUTH_DEFAULT_MODEL_REF = `xai/${XAI_OAUTH_AUTO_MODEL_ID}`;

function createXaiPresetAppliers(primaryModelRef: string, baseUrl = XAI_BASE_URL) {
  return createModelCatalogPresetAppliers<["openai-completions" | "openai-responses"]>({
    primaryModelRef,
    resolveParams: (_cfg: OpenClawConfig, api) => ({
      providerId: "xai",
      api,
      baseUrl,
      catalogModels: buildXaiCatalogModels(),
      aliases: [{ modelRef: primaryModelRef, alias: "Grok" }],
    }),
  });
}

const xaiPresetAppliers = createXaiPresetAppliers(XAI_DEFAULT_MODEL_REF);
const xaiOAuthPresetAppliers = createXaiPresetAppliers(
  XAI_OAUTH_DEFAULT_MODEL_REF,
  XAI_GROK_OAUTH_BASE_URL,
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

function discardXaiModelOverrides(cfg: OpenClawConfig): OpenClawConfig {
  const provider = cfg.models?.providers?.xai;
  if (!provider || !Array.isArray(provider.models) || provider.models.length === 0) {
    return cfg;
  }
  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: {
        ...cfg.models?.providers,
        xai: { ...provider, models: [] },
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
  const applied = xaiOAuthPresetAppliers.applyConfig(
    discardXaiModelOverrides(pruneRetiredXaiBuiltinModels(cfg)),
    "openai-responses",
  );
  const configured = applied.models?.providers?.xai;
  const { apiKey: _apiKey, authHeader: _authHeader, headers: _headers, request, ...safeProvider } =
    configured ?? {};
  const { auth: _requestAuth, headers: _requestHeaders, ...safeRequest } = request ?? {};
  const models = safeProvider.models?.filter((model) => model.id !== XAI_OAUTH_AUTO_MODEL_ID) ?? [];
  return {
    ...applied,
    models: {
      ...applied.models,
      providers: {
        ...applied.models?.providers,
        xai: {
          ...safeProvider,
          ...(Object.keys(safeRequest).length > 0 ? { request: safeRequest } : {}),
          auth: "oauth",
          models,
        },
      },
    },
  };
}

/**
 * Carries the authenticated OAuth catalog into a staged setup config. The persisted
 * selector remains `xai/auto`; the concrete canonical target is probe-only.
 */
export function applyXaiOAuthLiveCatalogConfig(
  cfg: OpenClawConfig,
  provider: Pick<ModelProviderConfig, "api" | "auth" | "baseUrl" | "models">,
): OpenClawConfig {
  const applied = applyXaiOAuthConfig(cfg);
  const configured = applied.models?.providers?.xai;
  return {
    ...applied,
    models: {
      ...applied.models,
      providers: {
        ...applied.models?.providers,
        xai: {
          ...configured,
          api: provider.api,
          ...(provider.auth ? { auth: provider.auth } : {}),
          baseUrl: provider.baseUrl,
          models: provider.models,
        },
      },
    },
  };
}
