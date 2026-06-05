/**
 * Provider auth resolution entry points used during model config generation.
 * The resolvers return env/profile/config marker values so discovery can prove
 * auth availability without writing secret material into generated config.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderAuthEvidence } from "../secrets/provider-env-vars.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  resolveNonEnvSecretRefApiKeyMarker,
} from "./model-auth-markers.js";
import {
  listAuthProfilesForProvider,
  normalizeApiKeyConfig,
  resolveApiKeyFromCredential,
  resolveApiKeyFromProfiles,
  resolveEnvApiKeyVarName,
  toDiscoveryApiKey,
  type ProviderApiKeyResolver,
  type ProviderAuthResolver,
} from "./models-config.providers.secret-helpers.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

export type {
  ProfileApiKeyResolution,
  ProviderApiKeyResolver,
  ProviderAuthResolver,
  ProviderConfig,
  SecretDefaults,
} from "./models-config.providers.secret-helpers.js";

export {
  listAuthProfilesForProvider,
  normalizeApiKeyConfig,
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromCredential,
  resolveApiKeyFromProfiles,
  resolveAwsSdkApiKeyVarName,
  resolveEnvApiKeyVarName,
  resolveMissingProviderApiKey,
  toDiscoveryApiKey,
} from "./models-config.providers.secret-helpers.js";

type AuthProfileStoreInput = AuthProfileStore | (() => AuthProfileStore);
type ProviderAuthLookupCaches = {
  aliasMap: Readonly<Record<string, string>>;
  candidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
};

function resolveAuthProfileStoreInput(input: AuthProfileStoreInput) {
  return typeof input === "function" ? input() : input;
}

function createProviderAuthLookupCaches(
  env: NodeJS.ProcessEnv,
  config?: OpenClawConfig,
): () => ProviderAuthLookupCaches {
  let caches: ProviderAuthLookupCaches | undefined;
  return () => {
    if (!caches) {
      // Env auth lookup maps are process-stable for a resolver instance, so one
      // cached normalization pass avoids repeating alias/candidate expansion.
      const lookupMaps = resolveProviderEnvAuthLookupMaps({ config, env });
      caches = {
        aliasMap: lookupMaps.aliasMap,
        candidateMap: lookupMaps.envCandidateMap,
        authEvidenceMap: lookupMaps.authEvidenceMap,
      };
    }
    return caches;
  };
}

function resolveProviderIdForAuthFromCaches(
  provider: string,
  caches: ProviderAuthLookupCaches,
): string {
  const normalized = normalizeProviderId(provider);
  if (!normalized) {
    return normalized;
  }
  return caches.aliasMap[normalized] ?? normalized;
}

/** Create a resolver that returns redacted API-key markers for provider discovery. */
export function createProviderApiKeyResolver(
  env: NodeJS.ProcessEnv,
  authStoreInput: AuthProfileStoreInput,
  config?: OpenClawConfig,
): ProviderApiKeyResolver {
  const getLookupCaches = createProviderAuthLookupCaches(env, config);
  return (provider: string): { apiKey: string | undefined; discoveryApiKey?: string } => {
    const lookupCaches = getLookupCaches();
    const authProvider = resolveProviderIdForAuthFromCaches(provider, lookupCaches);
    const envVar = resolveEnvApiKeyVarName(authProvider, env, {
      aliasMap: lookupCaches.aliasMap,
      candidateMap: lookupCaches.candidateMap,
      authEvidenceMap: lookupCaches.authEvidenceMap,
    });
    if (envVar) {
      // Public return value carries the env var name, while discovery receives
      // only the redacted/hashable value form.
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
      };
    }
    const fromConfig = resolveConfigBackedProviderAuth({
      provider: authProvider,
      config,
      env,
      authProvider,
    });
    if (fromConfig?.apiKey) {
      return {
        apiKey: fromConfig.apiKey,
        discoveryApiKey: fromConfig.discoveryApiKey,
      };
    }
    const fromProfiles = resolveApiKeyFromProfiles({
      provider: authProvider,
      store: resolveAuthProfileStoreInput(authStoreInput),
      env,
    });
    return fromProfiles?.apiKey
      ? {
          apiKey: fromProfiles.apiKey,
          discoveryApiKey: fromProfiles.discoveryApiKey,
        }
      : { apiKey: undefined, discoveryApiKey: undefined };
  };
}

/** Create a resolver that reports provider auth mode and provenance. */
export function createProviderAuthResolver(
  env: NodeJS.ProcessEnv,
  authStoreInput: AuthProfileStoreInput,
  config?: OpenClawConfig,
): ProviderAuthResolver {
  const getLookupCaches = createProviderAuthLookupCaches(env, config);
  return (provider: string, options?: { oauthMarker?: string }) => {
    const lookupCaches = getLookupCaches();
    const authProvider = resolveProviderIdForAuthFromCaches(provider, lookupCaches);
    const authStore = resolveAuthProfileStoreInput(authStoreInput);
    const ids = listAuthProfilesForProvider(authStore, authProvider);

    let oauthCandidate:
      | {
          apiKey: string | undefined;
          discoveryApiKey?: string;
          mode: "oauth";
          source: "profile";
          profileId: string;
        }
      | undefined;
    for (const id of ids) {
      const cred = authStore.profiles[id];
      if (!cred) {
        continue;
      }
      if (cred.type === "oauth") {
        // Prefer concrete API-key profiles, but keep one OAuth profile as a
        // fallback so provider routing can advertise OAuth-backed availability.
        oauthCandidate ??= {
          apiKey: options?.oauthMarker,
          discoveryApiKey: toDiscoveryApiKey(cred.access),
          mode: "oauth",
          source: "profile",
          profileId: id,
        };
        continue;
      }
      const resolved = resolveApiKeyFromCredential(cred, env);
      if (!resolved) {
        continue;
      }
      return {
        apiKey: resolved.apiKey,
        discoveryApiKey: resolved.discoveryApiKey,
        mode: cred.type,
        source: "profile" as const,
        profileId: id,
      };
    }
    if (oauthCandidate) {
      return oauthCandidate;
    }

    const envVar = resolveEnvApiKeyVarName(authProvider, env, {
      aliasMap: lookupCaches.aliasMap,
      candidateMap: lookupCaches.candidateMap,
      authEvidenceMap: lookupCaches.authEvidenceMap,
    });
    if (envVar) {
      return {
        apiKey: envVar,
        discoveryApiKey: toDiscoveryApiKey(env[envVar]),
        mode: "api_key" as const,
        source: "env" as const,
      };
    }

    const fromConfig = resolveConfigBackedProviderAuth({
      provider: authProvider,
      config,
      env,
      authProvider,
    });
    if (fromConfig) {
      return {
        apiKey: fromConfig.apiKey,
        discoveryApiKey: fromConfig.discoveryApiKey,
        mode: fromConfig.mode,
        source: "none",
      };
    }
    return {
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    };
  };
}

function resolveConfigBackedProviderAuth(params: {
  provider: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authProvider?: string;
}):
  | {
      apiKey: string;
      discoveryApiKey?: string;
      mode: "api_key";
      source: "config";
    }
  | undefined {
  const authProvider =
    params.authProvider ?? resolveProviderIdForAuth(params.provider, { config: params.config });
  const synthetic = resolveProviderSyntheticAuthWithPlugin({
    provider: authProvider,
    config: params.config,
    context: {
      config: params.config,
      provider: authProvider,
      providerConfig: params.config?.models?.providers?.[authProvider],
    },
  });
  const apiKey = synthetic?.apiKey?.trim();
  if (apiKey) {
    // Synthetic plugin auth can prove configured availability, but non-marker
    // values must not be written back as raw generated config secrets.
    return isNonSecretApiKeyMarker(apiKey)
      ? {
          apiKey,
          discoveryApiKey: toDiscoveryApiKey(apiKey),
          mode: "api_key",
          source: "config",
        }
      : {
          apiKey: resolveNonEnvSecretRefApiKeyMarker("file"),
          discoveryApiKey: toDiscoveryApiKey(apiKey),
          mode: "api_key",
          source: "config",
        };
  }

  const configuredProvider = params.config?.models?.providers?.[authProvider];
  const configuredProviderApiKey = configuredProvider?.apiKey;
  const configuredApiKeyRef = resolveSecretInputRef({
    value: configuredProviderApiKey,
    defaults: params.config?.secrets?.defaults,
  }).ref;
  if (configuredApiKeyRef) {
    // Secret refs are preserved as markers. Env refs can still provide a
    // discovery value from the current process without exposing the secret name's value.
    if (configuredApiKeyRef.source === "env") {
      const envVar = configuredApiKeyRef.id.trim();
      const envValue = params.env?.[envVar]?.trim();
      return envValue
        ? {
            apiKey: envVar,
            discoveryApiKey: toDiscoveryApiKey(envValue),
            mode: "api_key",
            source: "config",
          }
        : undefined;
    }
    return {
      apiKey: resolveNonEnvSecretRefApiKeyMarker(configuredApiKeyRef.source),
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "config",
    };
  }
  if (typeof configuredProviderApiKey !== "string") {
    return undefined;
  }
  const configuredApiKey = normalizeApiKeyConfig(configuredProviderApiKey);
  if (!configuredApiKey) {
    return undefined;
  }
  if (isKnownEnvApiKeyMarker(configuredApiKey)) {
    const envValue = params.env?.[configuredApiKey]?.trim();
    if (envValue) {
      return {
        apiKey: configuredApiKey,
        discoveryApiKey: toDiscoveryApiKey(envValue),
        mode: "api_key",
        source: "config",
      };
    }
    return undefined;
  }
  return isNonSecretApiKeyMarker(configuredApiKey)
    ? {
        apiKey: configuredApiKey,
        discoveryApiKey: toDiscoveryApiKey(configuredApiKey),
        mode: "api_key",
        source: "config",
      }
    : {
        apiKey: configuredApiKey,
        discoveryApiKey: toDiscoveryApiKey(configuredApiKey),
        mode: "api_key",
        source: "config",
      };
}
