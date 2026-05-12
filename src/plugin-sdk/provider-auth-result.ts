import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthResult } from "../plugins/types.js";

function normalizeAgentModelConfigForAuthResult(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  let mutated = false;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (typeof next.primary === "string") {
    const primary = normalizeAgentModelRefForConfig(next.primary);
    if (primary !== next.primary) {
      next.primary = primary;
      mutated = true;
    }
  }
  if (Array.isArray(next.fallbacks)) {
    const originalFallbacks = next.fallbacks;
    const fallbacks = originalFallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
    if (fallbacks.some((fallback, index) => fallback !== originalFallbacks[index])) {
      next.fallbacks = fallbacks;
      mutated = true;
    }
  }
  return mutated ? next : value;
}

function normalizeProviderConfigModelIdsForAuthResult(
  provider: string,
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  const models = providerConfig.models;
  if (!Array.isArray(models) || models.length === 0) {
    return providerConfig;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const id = normalizeConfiguredProviderCatalogModelId(provider, model.id);
    if (id === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id });
  });
  return mutated ? { ...providerConfig, models: nextModels } : providerConfig;
}

function normalizeProviderAuthConfigPatchModelRefs(
  patch: Partial<OpenClawConfig>,
): Partial<OpenClawConfig> {
  let next = patch;
  const defaults = patch.agents?.defaults;
  if (defaults) {
    let nextDefaults = defaults;
    if (defaults.model !== undefined) {
      const model = normalizeAgentModelConfigForAuthResult(defaults.model);
      if (model !== defaults.model) {
        nextDefaults = { ...nextDefaults, model: model as typeof defaults.model };
      }
    }
    if (defaults.models) {
      const models = normalizeAgentModelMapForConfig(defaults.models);
      if (models !== defaults.models) {
        nextDefaults = { ...nextDefaults, models };
      }
    }
    if (nextDefaults !== defaults) {
      next = {
        ...next,
        agents: {
          ...next.agents,
          defaults: nextDefaults,
        },
      };
    }
  }

  const providers = patch.models?.providers;
  if (!providers) {
    return next;
  }

  let mutated = false;
  const nextProviders = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    const normalized = normalizeProviderConfigModelIdsForAuthResult(provider, providerConfig);
    if (normalized === providerConfig) {
      continue;
    }
    nextProviders[provider] = normalized;
    mutated = true;
  }

  return mutated
    ? {
        ...next,
        models: {
          ...next.models,
          providers: nextProviders,
        },
      }
    : next;
}

/** Build the standard auth result payload for OAuth-style provider login flows. */
export function buildOauthProviderAuthResult(params: {
  providerId: string;
  defaultModel: string;
  access: string;
  refresh?: string | null;
  expires?: number | null;
  email?: string | null;
  displayName?: string | null;
  profileName?: string | null;
  profilePrefix?: string;
  credentialExtra?: Record<string, unknown>;
  configPatch?: Partial<OpenClawConfig>;
  notes?: string[];
}): ProviderAuthResult {
  const email = params.email ?? undefined;
  const displayName = params.displayName ?? undefined;
  const defaultModel = normalizeAgentModelRefForConfig(params.defaultModel);
  const profileId = buildAuthProfileId({
    providerId: params.providerId,
    profilePrefix: params.profilePrefix,
    profileName: params.profileName ?? email,
  });

  const credential: AuthProfileCredential = {
    type: "oauth",
    provider: params.providerId,
    access: params.access,
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(Number.isFinite(params.expires) ? { expires: params.expires as number } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    ...params.credentialExtra,
  } as AuthProfileCredential;

  return {
    profiles: [{ profileId, credential }],
    configPatch: normalizeProviderAuthConfigPatchModelRefs(
      params.configPatch ??
        ({
          agents: {
            defaults: {
              models: {
                [defaultModel]: {},
              },
            },
          },
        } as Partial<OpenClawConfig>),
    ),
    defaultModel,
    notes: params.notes,
  };
}
