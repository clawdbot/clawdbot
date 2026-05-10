import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared.js";
import {
  normalizeProviderSpecificConfig,
  resolveProviderConfigApiKeyResolver,
} from "./models-config.providers.policy.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderModelConfig = NonNullable<
  NonNullable<ModelsConfig["providers"]>[string]["models"]
>[number];

function getProviderModelId(model: ProviderModelConfig): string | undefined {
  return typeof model.id === "string" && model.id.trim() ? model.id : undefined;
}

function mergeNormalizedProviderModel(
  existing: ProviderModelConfig,
  incoming: ProviderModelConfig,
): ProviderModelConfig {
  return {
    ...incoming,
    ...existing,
    ...(existing.cost || incoming.cost
      ? {
          cost: {
            ...incoming.cost,
            ...existing.cost,
          },
        }
      : undefined),
  };
}

function normalizeProviderModelsForConfig(
  providerKey: string,
  provider: ProviderConfig,
): { provider: ProviderConfig; mutated: boolean } {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return { provider, mutated: false };
  }

  let mutated = false;
  const nextModels: ProviderModelConfig[] = [];
  const seenById = new Map<string, number>();
  for (const model of provider.models) {
    const rawId = getProviderModelId(model);
    const normalizedId = rawId
      ? normalizeConfiguredProviderCatalogModelId(providerKey, rawId)
      : rawId;
    const normalizedModel =
      normalizedId && normalizedId !== rawId ? { ...model, id: normalizedId } : model;
    if (normalizedModel !== model) {
      mutated = true;
    }
    const id = getProviderModelId(normalizedModel);
    if (id) {
      const existingIndex = seenById.get(id);
      if (existingIndex !== undefined) {
        mutated = true;
        nextModels[existingIndex] = mergeNormalizedProviderModel(
          nextModels[existingIndex],
          normalizedModel,
        );
        continue;
      }
      seenById.set(id, nextModels.length);
    }
    nextModels.push(normalizedModel);
  }

  return mutated
    ? { provider: { ...provider, models: nextModels }, mutated }
    : { provider, mutated };
}

export function normalizeProviderCatalogModelsForConfig(
  providers: ModelsConfig["providers"],
): ModelsConfig["providers"] {
  if (!providers) {
    return providers;
  }

  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [providerKey, provider] of Object.entries(providers)) {
    const normalized = normalizeProviderModelsForConfig(providerKey, provider);
    if (normalized.mutated) {
      mutated = true;
    }
    next[providerKey] = normalized.provider;
  }

  return mutated ? next : providers;
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceProviders?: ModelsConfig["providers"];
  sourceSecretDefaults?: SecretDefaults;
  secretRefManagedProviders?: Set<string>;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const resolveProfileApiKey = (providerKey: string) => {
    authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    return resolveApiKeyFromProfiles({
      provider: providerKey,
      store: authStore,
      env,
    });
  };
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      mutated = true;
      continue;
    }
    if (normalizedKey !== key) {
      mutated = true;
    }
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
    });
    if (normalizedHeaders.mutated) {
      mutated = true;
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const providerWithConfiguredApiKey = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey: undefined,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithConfiguredApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithConfiguredApiKey;
    }

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    const providerWithResolvedEnvApiKey = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });
    if (providerWithResolvedEnvApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithResolvedEnvApiKey;
    }

    const needsProfileApiKey =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0 &&
      !(
        (typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim()) ||
        normalizedProvider.apiKey
      );
    const profileApiKey = needsProfileApiKey ? resolveProfileApiKey(normalizedKey) : undefined;
    const providerApiKeyResolver = needsProfileApiKey
      ? resolveProviderConfigApiKeyResolver(normalizedKey)
      : undefined;
    const providerWithApiKey = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver,
    });
    if (providerWithApiKey !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerWithApiKey;
    }

    const providerSpecificNormalized = normalizeProviderSpecificConfig(
      normalizedKey,
      normalizedProvider,
    );
    if (providerSpecificNormalized !== normalizedProvider) {
      mutated = true;
      normalizedProvider = providerSpecificNormalized;
    }

    const providerWithNormalizedModels = normalizeProviderModelsForConfig(
      normalizedKey,
      normalizedProvider,
    );
    if (providerWithNormalizedModels.mutated) {
      mutated = true;
      normalizedProvider = providerWithNormalizedModels.provider;
    }

    const existing = next[normalizedKey];
    if (existing) {
      // Keep deterministic behavior if users accidentally define duplicate
      // provider keys that only differ by surrounding whitespace.
      mutated = true;
      next[normalizedKey] = {
        ...existing,
        ...normalizedProvider,
        models: normalizedProvider.models ?? existing.models,
      };
      continue;
    }
    next[normalizedKey] = normalizedProvider;
  }

  const normalizedProviders = mutated ? next : providers;
  return enforceSourceManagedProviderSecrets({
    providers: normalizedProviders,
    sourceProviders: params.sourceProviders,
    sourceSecretDefaults: params.sourceSecretDefaults,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}
