// Provider auth result helpers normalize credential checks into stable setup/status results.
import { asDateTimestampMs } from "../../packages/normalization-core/src/number-coercion.js";
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
    // OAuth helpers can be called by provider setup code before config writes, so normalize
    // legacy model refs here instead of letting retired ids leak into persisted defaults.
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
    // Provider catalogs embedded in auth patches need the same id normalization as top-level
    // agent defaults, otherwise setup can write a mixed old/new provider catalog.
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

/**
 * Builds the standard auth result payload for OAuth-style provider login flows.
 *
 * The helper emits both the credential profile and the config patch expected by setup callers,
 * while normalizing model refs so OAuth imports do not persist retired catalog ids.
 */
export function buildOauthProviderAuthResult(params: {
  /** Provider id stored on the auth profile credential and profile id. */
  providerId: string;
  /** Default model ref to seed into config when no explicit patch is supplied. */
  defaultModel: string;
  /** OAuth access token persisted in the generated auth profile. */
  access: string;
  /** Optional OAuth refresh token persisted when present. */
  refresh?: string | null;
  /** Optional expiry timestamp or date-like value normalized to Date-safe milliseconds. */
  expires?: number | null;
  /** Account email used for credential metadata and default profile naming. */
  email?: string | null;
  /** Human-readable account label stored in credential metadata. */
  displayName?: string | null;
  /** Explicit profile name used when deriving the auth profile id. */
  profileName?: string | null;
  /** Optional prefix added to the generated auth profile id. */
  profilePrefix?: string;
  /** Provider-specific credential fields merged into the OAuth credential. */
  credentialExtra?: Record<string, unknown>;
  /** Explicit config patch to emit after model-ref normalization. */
  configPatch?: Partial<OpenClawConfig>;
  /** Optional setup notes forwarded to provider login callers. */
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
  const expires = asDateTimestampMs(params.expires);

  const credential: AuthProfileCredential = {
    type: "oauth",
    provider: params.providerId,
    access: params.access,
    ...(params.refresh ? { refresh: params.refresh } : {}),
    ...(expires !== undefined ? { expires } : {}),
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
