// Resolves provider usage auth tokens from profiles, plugins, and env.
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { isOAuthOnlyUsageProvider } from "./provider-usage.shared.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
  authProfileId?: string;
  hookProvider?: string;
  /** Non-secret plan metadata from the resolved credential (e.g. Claude "max"). */
  subscriptionType?: string;
  rateLimitTier?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  allowAuthProfileStore: boolean;
  store?: AuthStore;
};

function resolveUsageAuthStore(state: UsageAuthState): AuthStore {
  state.store ??= ensureAuthProfileStore(state.agentDir, {
    allowKeychainPrompt: false,
  });
  return state.store;
}

function resolveProviderApiKeyFromConfig(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  const envDirect = params.envDirect?.map(normalizeSecretInput).find(Boolean);
  if (envDirect) {
    return envDirect;
  }

  for (const providerId of params.providerIds) {
    const envKey = resolveEnvApiKey(providerId, params.state.env)?.apiKey;
    if (envKey) {
      return envKey;
    }
    const key = resolveUsableCustomProviderApiKey({
      cfg: params.state.cfg,
      provider: providerId,
      env: params.state.env,
    })?.apiKey;
    if (key) {
      return key;
    }
  }
  return undefined;
}

function hasProviderAuthEnvCredentialSource(params: {
  state: UsageAuthState;
  providerIds: string[];
}): boolean {
  const candidates = resolveProviderAuthEnvVarCandidates({
    config: params.state.cfg,
    env: {
      ...(process.env.VITEST ? process.env : {}),
      ...params.state.env,
    },
  });
  for (const providerId of normalizeProviderIds(params.providerIds)) {
    const envVars = Object.hasOwn(candidates, providerId) ? candidates[providerId] : undefined;
    if (!envVars) {
      continue;
    }
    if (envVars.some((envVar) => Boolean(normalizeSecretInput(params.state.env[envVar])))) {
      return true;
    }
  }
  return false;
}

function hasProviderUsageAuthEnvCredentialSource(params: {
  state: UsageAuthState;
  providerIds: string[];
}): boolean {
  const providerIds = new Set(normalizeProviderIds(params.providerIds));
  try {
    const snapshot = loadManifestMetadataSnapshot({
      config: params.state.cfg,
      env: params.state.env,
    });
    return snapshot.plugins.some((plugin) => {
      if (!isUsageProviderManifestEligible({ plugin, state: params.state })) {
        return false;
      }
      return Object.entries(plugin.providerUsageAuthEnvVars ?? {}).some(
        ([providerId, envVars]) =>
          providerIds.has(normalizeProviderId(providerId)) &&
          envVars.some((envVar) => Boolean(normalizeSecretInput(params.state.env[envVar]))),
      );
    });
  } catch {
    return false;
  }
}

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  return resolveProviderApiKeyCandidatesFromConfigAndStoreSync(params)[0];
}

function resolveProviderApiKeyCandidatesFromConfigAndStoreSync(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string[] {
  const candidates: string[] = [];
  const configKey = resolveProviderApiKeyFromConfig(params);
  if (configKey) {
    candidates.push(configKey);
  }
  if (!params.state.allowAuthProfileStore) {
    return candidates;
  }

  const normalizedProviderIds = new Set(
    normalizeUniqueStringEntries(
      params.providerIds.map((providerId) => normalizeProviderId(providerId)),
    ),
  );
  const store = resolveUsageAuthStore(params.state);
  const credentials = [...normalizedProviderIds]
    .flatMap((provider) => resolveAuthProfileOrder({ cfg: params.state.cfg, store, provider }))
    .map((id) => store.profiles[id])
    .filter(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  for (const credential of credentials) {
    const value = normalizeSecretInput(
      credential.type === "api_key" ? credential.key : credential.token,
    );
    if (value && !isNonSecretApiKeyMarker(value)) {
      candidates.push(value);
    }
  }
  return normalizeUniqueStringEntries(candidates);
}

async function resolveProviderApiKeyCandidatesFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): Promise<string[]> {
  const candidates: string[] = [];
  const configKey = resolveProviderApiKeyFromConfig(params);
  if (configKey) {
    candidates.push(configKey);
  }
  if (!params.state.allowAuthProfileStore) {
    return candidates;
  }

  const store = resolveUsageAuthStore(params.state);
  const profileIds = dedupeProfileIds(
    normalizeProviderIds(params.providerIds).flatMap((provider) =>
      resolveAuthProfileOrder({ cfg: params.state.cfg, store, provider }),
    ),
  );
  for (const profileId of profileIds) {
    const credential = store.profiles[profileId];
    if (!credential || (credential.type !== "api_key" && credential.type !== "token")) {
      continue;
    }
    let resolved: Awaited<ReturnType<typeof resolveApiKeyForProfile>>;
    try {
      // Candidate classification must see SecretRef-backed values too; reading
      // profile fields directly would silently skip the secure storage path.
      resolved = await resolveApiKeyForProfile({
        cfg: params.state.cfg,
        store,
        profileId,
        agentDir: params.state.agentDir,
      });
    } catch {
      // Preserve the remaining credential candidates when one SecretRef fails.
      continue;
    }
    const value = normalizeSecretInput(resolved?.apiKey);
    if (value && !isNonSecretApiKeyMarker(value)) {
      candidates.push(value);
    }
  }
  return normalizeUniqueStringEntries(candidates);
}

function normalizeProviderIds(providerIds: Iterable<string | undefined>): string[] {
  return [
    ...new Set(
      [...providerIds]
        .map((providerId) => (providerId ? normalizeProviderId(providerId) : undefined))
        .filter((providerId): providerId is string => Boolean(providerId)),
    ),
  ];
}

function isUsageProviderManifestEligible(params: {
  plugin: PluginManifestRecord;
  state: UsageAuthState;
}): boolean {
  const normalizedConfig = normalizePluginsConfig(params.state.cfg.plugins);
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig,
    })
  ) {
    return false;
  }
  if (params.plugin.origin !== "workspace") {
    return true;
  }
  return isActivatedManifestOwner({
    plugin: params.plugin,
    normalizedConfig,
    rootConfig: params.state.cfg,
  });
}

function resolveUsageCredentialProviderIds(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): string[] {
  const providerIds = new Set(normalizeProviderIds([params.provider]));
  const providerIdSet = new Set(providerIds);
  try {
    const snapshot = loadManifestMetadataSnapshot({
      config: params.state.cfg,
      env: params.state.env,
    });
    for (const plugin of snapshot.plugins) {
      const pluginProviderIds = normalizeProviderIds(plugin.providers);
      if (!pluginProviderIds.some((providerId) => providerIdSet.has(providerId))) {
        continue;
      }
      if (!isUsageProviderManifestEligible({ plugin, state: params.state })) {
        continue;
      }
      for (const providerId of pluginProviderIds) {
        providerIds.add(providerId);
      }
    }
  } catch {
    // Credential-source checks are an optimization gate; preserve usage fallback
    // behavior if manifest discovery is unavailable in a constrained environment.
  }
  return [...providerIds];
}

async function resolveOAuthToken(params: {
  state: UsageAuthState;
  provider: string;
}): Promise<ProviderAuth | null> {
  if (!params.state.allowAuthProfileStore) {
    return null;
  }
  const store = resolveUsageAuthStore(params.state);
  const order = resolveAuthProfileOrder({
    cfg: params.state.cfg,
    store,
    provider: params.provider,
  });
  const deduped = dedupeProfileIds(order);

  for (const profileId of deduped) {
    const cred = store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) {
      continue;
    }
    try {
      const resolved = await resolveApiKeyForProfile({
        // Reuse the already-resolved config snapshot for token/ref resolution so
        // usage snapshots don't trigger a second ambient getRuntimeConfig() call.
        cfg: params.state.cfg,
        store,
        profileId,
        agentDir: params.state.agentDir,
      });
      if (!resolved) {
        continue;
      }
      return {
        provider: params.provider as UsageProviderId,
        token: resolved.apiKey,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
        // Plan metadata is captured at external CLI sync time; runtime usage
        // fetches must not re-read CLI keychains, so the stored profile is the
        // only prompt-free source for plan labels.
        ...(cred.type === "oauth" && cred.subscriptionType
          ? { subscriptionType: cred.subscriptionType }
          : {}),
        ...(cred.type === "oauth" && cred.rateLimitTier
          ? { rateLimitTier: cred.rateLimitTier }
          : {}),
      };
    } catch {
      // ignore
    }
  }

  return null;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<{ handled: boolean; auth: ProviderAuth | null }> {
  const resolved = await resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      // Provider-owned hooks may route API keys to a different billing endpoint
      // even when generic fallback for this usage provider remains OAuth-only.
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
        }),
      resolveApiKeyCandidatesFromConfigAndStore: (options) =>
        resolveProviderApiKeyCandidatesFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: options?.envDirect,
        }),
      resolveOAuthToken: async (options) => {
        const auth = await resolveOAuthToken({
          state: params.state,
          provider: options?.provider ?? params.provider,
        });
        return auth
          ? {
              token: auth.token,
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
              ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
              ...(auth.rateLimitTier ? { rateLimitTier: auth.rateLimitTier } : {}),
            }
          : null;
      },
    },
  });
  if (!resolved) {
    return { handled: false, auth: null };
  }
  if ("handled" in resolved) {
    return { handled: true, auth: null };
  }
  return {
    handled: true,
    auth: {
      provider: params.provider,
      token: resolved.token,
      ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
      ...(resolved.subscriptionType ? { subscriptionType: resolved.subscriptionType } : {}),
      ...(resolved.rateLimitTier ? { rateLimitTier: resolved.rateLimitTier } : {}),
    },
  };
}

async function resolveProviderUsageAuthFallback(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
}): Promise<ProviderAuth | null> {
  const oauthToken = await resolveOAuthToken({
    state: params.state,
    provider: params.provider,
  });
  if (oauthToken) {
    return oauthToken;
  }
  if (isOAuthOnlyUsageProvider(params.provider)) {
    return null;
  }

  const apiKey = resolveProviderApiKeyFromConfigAndStore({
    state: params.state,
    providerIds: [params.provider],
  });
  if (apiKey) {
    return {
      provider: params.provider,
      token: apiKey,
    };
  }

  return null;
}

function hasAuthProfileCredentialSource(params: {
  state: UsageAuthState;
  providerIds: string[];
}): boolean {
  const store = ensureAuthProfileStoreWithoutExternalProfiles(params.state.agentDir, {
    allowKeychainPrompt: false,
  });
  for (const provider of params.providerIds) {
    const order = resolveAuthProfileOrder({
      cfg: params.state.cfg,
      store,
      provider,
    });
    if (
      dedupeProfileIds(order).some((profileId) => {
        const cred = store.profiles[profileId];
        return (
          cred?.type === "oauth" ||
          cred?.type === "token" ||
          // A provider hook may route an API key to a separate billing endpoint
          // even when generic usage fallback for the provider stays OAuth-only.
          cred?.type === "api_key"
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  skipPluginAuthWithoutCredentialSource?: boolean;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const stateBase = {
    cfg: params.config ?? getRuntimeConfig(),
    env: params.env ?? process.env,
    agentDir: params.agentDir,
  };
  const authProfileSourceState: UsageAuthState = {
    ...stateBase,
    allowAuthProfileStore: true,
  };
  const hasAuthProfileStoreSource = params.skipPluginAuthWithoutCredentialSource
    ? hasAnyAuthProfileStoreSource(params.agentDir)
    : false;
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    if (!params.skipPluginAuthWithoutCredentialSource) {
      const pluginAuth = await resolveProviderUsageAuthViaPlugin({
        state: authProfileSourceState,
        provider,
      });
      if (pluginAuth.auth) {
        auths.push(pluginAuth.auth);
        continue;
      }
      if (pluginAuth.handled) {
        continue;
      }
      const fallbackAuth = await resolveProviderUsageAuthFallback({
        state: authProfileSourceState,
        provider,
      });
      if (fallbackAuth) {
        auths.push(fallbackAuth);
      }
      continue;
    }

    const directCredentialState = { ...stateBase, allowAuthProfileStore: false };
    const credentialProviderIds = resolveUsageCredentialProviderIds({
      state: directCredentialState,
      provider,
    });
    const hasDirectCredentialSource =
      Boolean(
        resolveProviderApiKeyFromConfig({
          state: directCredentialState,
          providerIds: credentialProviderIds,
        }),
      ) ||
      hasProviderAuthEnvCredentialSource({
        state: directCredentialState,
        providerIds: credentialProviderIds,
      }) ||
      hasProviderUsageAuthEnvCredentialSource({
        state: directCredentialState,
        providerIds: credentialProviderIds,
      });
    const allowAuthProfileStore =
      hasDirectCredentialSource ||
      (hasAuthProfileStoreSource &&
        hasAuthProfileCredentialSource({
          state: authProfileSourceState,
          providerIds: credentialProviderIds,
        }));
    const state: UsageAuthState = {
      ...stateBase,
      allowAuthProfileStore,
    };
    const hasPluginCredentialSource = hasDirectCredentialSource || allowAuthProfileStore;

    if (hasPluginCredentialSource) {
      const pluginAuth = await resolveProviderUsageAuthViaPlugin({
        state,
        provider,
      });
      if (pluginAuth.auth) {
        auths.push(pluginAuth.auth);
        continue;
      }
      if (pluginAuth.handled) {
        continue;
      }
    }
    const fallbackAuth = await resolveProviderUsageAuthFallback({
      state,
      provider,
    });
    if (fallbackAuth) {
      auths.push(fallbackAuth);
    }
  }

  return auths;
}
