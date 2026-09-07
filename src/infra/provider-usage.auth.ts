// Resolves provider usage auth tokens from profiles, plugins, and env.
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  resolveApiKeyForProfile,
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import {
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth.js";
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
  /** Account email captured on the resolved credential, when known. */
  email?: string;
};

type AuthStore = ReturnType<typeof ensureAuthProfileStore>;

type UsageAuthState = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir?: string;
  allowAuthProfileStore: boolean;
  providerOnly?: boolean;
  getStore?: () => AuthStore;
  store?: AuthStore;
};

function resolveUsageAuthStore(state: UsageAuthState): AuthStore {
  state.store ??=
    state.getStore?.() ??
    ensureAuthProfileStore(state.agentDir, {
      allowKeychainPrompt: false,
    });
  if (!state.providerOnly) {
    return state.store;
  }
  // Filter before string-only plugin helpers erase credential ownership. Login
  // keys belong to exact-account usage, even when stored as API-key credentials.
  return {
    ...state.store,
    profiles: Object.fromEntries(
      Object.entries(state.store.profiles).filter(
        ([, credential]) => credential.type === "api_key" && !credential.metadata?.authFlow,
      ),
    ),
  };
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
    if (params.state.providerOnly && params.state.allowAuthProfileStore) {
      const binding = resolveProviderEntryApiKeyProfileReference({
        cfg: params.state.cfg,
        provider: providerId,
        store: resolveUsageAuthStore({ ...params.state, providerOnly: false }),
      });
      if ("profileId" in binding) {
        continue;
      }
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

export function resolveProviderUsageAuthEnvCredentialProviders(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginManifestRecord[];
}): Set<string> {
  const state: UsageAuthState = {
    cfg: params.config,
    env: params.env ?? process.env,
    allowAuthProfileStore: false,
  };
  const providers = new Set<string>();
  try {
    const plugins =
      params.plugins ??
      loadManifestMetadataSnapshot({
        config: state.cfg,
        env: state.env,
      }).plugins;
    for (const plugin of plugins) {
      if (!isUsageProviderManifestEligible({ plugin, state })) {
        continue;
      }
      for (const [providerId, envVars] of Object.entries(plugin.providerUsageAuthEnvVars ?? {})) {
        if (envVars.some((envVar) => Boolean(normalizeSecretInput(state.env[envVar])))) {
          providers.add(normalizeProviderId(providerId));
        }
      }
    }
  } catch {
    return providers;
  }
  return providers;
}

function hasProviderUsageAuthEnvCredentialSource(params: {
  state: UsageAuthState;
  providerIds: string[];
}): boolean {
  const providers = resolveProviderUsageAuthEnvCredentialProviders({
    config: params.state.cfg,
    env: params.state.env,
  });
  return normalizeProviderIds(params.providerIds).some((providerId) => providers.has(providerId));
}

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
  profileIds?: readonly string[];
}): string | undefined {
  return resolveProviderApiKeyCandidatesFromConfigAndStoreSync(params)[0];
}

function resolveProviderApiKeyCandidatesFromConfigAndStoreSync(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
  profileIds?: readonly string[];
}): string[] {
  const candidates: string[] = [];
  const configKey = params.profileIds ? undefined : resolveProviderApiKeyFromConfig(params);
  if (configKey) {
    candidates.push(configKey);
  }
  if (!params.state.allowAuthProfileStore) {
    return candidates;
  }

  const normalizedProviderIds = normalizeUniqueStringEntries(
    params.providerIds.map((providerId) => normalizeProviderId(providerId)),
  );
  const store = resolveUsageAuthStore(params.state);
  const profileIds = params.profileIds
    ? dedupeProfileIds([...params.profileIds])
    : normalizedProviderIds.flatMap((provider) =>
        resolveAuthProfileOrder({ cfg: params.state.cfg, store, provider }),
      );
  for (const profileId of profileIds) {
    const credential = store.profiles[profileId];
    if (!credential || (credential.type !== "api_key" && credential.type !== "token")) {
      continue;
    }
    // Pinning skips account ordering, not credential eligibility. Otherwise a
    // saved token's expiry or configured auth mode could be bypassed by usage.
    if (
      params.profileIds &&
      !normalizedProviderIds.some(
        (provider) =>
          resolveAuthProfileEligibility({ cfg: params.state.cfg, store, provider, profileId })
            .eligible,
      )
    ) {
      continue;
    }
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
  profileIds?: readonly string[];
}): Promise<string[]> {
  const candidates: string[] = [];
  const configKey = params.profileIds ? undefined : resolveProviderApiKeyFromConfig(params);
  if (configKey) {
    candidates.push(configKey);
  }
  if (!params.state.allowAuthProfileStore) {
    return candidates;
  }

  const store = resolveUsageAuthStore(params.state);
  const profileIds = params.profileIds
    ? dedupeProfileIds([...params.profileIds])
    : dedupeProfileIds(
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
    } catch (error) {
      // Unscoped discovery can try another credential. A pinned account must
      // report its own failure instead of completing with no usage or diagnostic.
      if (params.profileIds) {
        throw error;
      }
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
  excludeProfileIds?: string[];
  profileIds?: readonly string[];
  allowProfileFallback?: boolean;
}): Promise<ProviderAuth | null> {
  if (!params.state.allowAuthProfileStore) {
    return null;
  }
  const store = resolveUsageAuthStore(params.state);
  const order =
    params.profileIds ??
    resolveAuthProfileOrder({
      cfg: params.state.cfg,
      store,
      provider: params.provider,
    });
  const deduped = dedupeProfileIds([...order]);
  const excludedProfileIds = new Set(params.excludeProfileIds ?? []);

  for (const profileId of deduped) {
    if (excludedProfileIds.has(profileId)) {
      continue;
    }
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
        ...(params.allowProfileFallback === false ? { allowProfileFallback: false } : {}),
      });
      if (!resolved) {
        continue;
      }
      return {
        provider: params.provider as UsageProviderId,
        token: resolved.apiKey,
        authProfileId: profileId,
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
        // Token credentials carry an email too; oauth-only gating would drop
        // identity for static bearer profiles whose tokens expose no claims.
        ...(cred.email ? { email: cred.email } : {}),
      };
    } catch (error) {
      if (params.allowProfileFallback === false) {
        throw error;
      }
    }
  }

  return null;
}

/** Resolve one exact saved OAuth/token profile for account-scoped usage. */
export async function resolveProviderProfileUsageAuth(params: {
  provider: UsageProviderId;
  profileId: string;
  store: AuthProfileStore;
  agentDir?: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderAuth | null> {
  const state: UsageAuthState = {
    cfg: params.config,
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    allowAuthProfileStore: true,
    store: params.store,
  };
  const pluginAuth = await resolveProviderUsageAuthViaPlugin({
    state,
    provider: params.provider,
    authProfileId: params.profileId,
  });
  if (pluginAuth.auth) {
    return pluginAuth.auth;
  }
  if (pluginAuth.handled) {
    return null;
  }
  const auth = await resolveOAuthToken({
    state,
    provider: params.provider,
    profileIds: [params.profileId],
    allowProfileFallback: false,
  });
  return auth ? { ...auth, authProfileId: params.profileId } : null;
}

async function resolveProviderUsageAuthViaPlugin(params: {
  state: UsageAuthState;
  provider: UsageProviderId;
  authProfileId?: string;
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
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      // Provider-owned hooks may route API keys to a different billing endpoint
      // even when generic fallback for this usage provider remains OAuth-only.
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: params.authProfileId ? undefined : options?.envDirect,
          ...(params.authProfileId ? { profileIds: [params.authProfileId] } : {}),
        }),
      resolveApiKeyCandidatesFromConfigAndStore: (options) =>
        resolveProviderApiKeyCandidatesFromConfigAndStore({
          state: params.state,
          providerIds: options?.providerIds ?? [params.provider],
          envDirect: params.authProfileId ? undefined : options?.envDirect,
          ...(params.authProfileId ? { profileIds: [params.authProfileId] } : {}),
        }),
      resolveOAuthToken: async (options) => {
        const auth = await resolveOAuthToken({
          state: params.state,
          provider: options?.provider ?? params.provider,
          excludeProfileIds: options?.excludeProfileIds,
          ...(params.authProfileId ? { profileIds: [params.authProfileId] } : {}),
          ...(params.authProfileId ? { allowProfileFallback: false } : {}),
        });
        return auth
          ? {
              token: auth.token,
              ...(auth.authProfileId ? { authProfileId: auth.authProfileId } : {}),
              ...(auth.accountId ? { accountId: auth.accountId } : {}),
              ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
              ...(auth.rateLimitTier ? { rateLimitTier: auth.rateLimitTier } : {}),
              ...(auth.email ? { email: auth.email } : {}),
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
      ...(resolved.email ? { email: resolved.email } : {}),
      ...(params.authProfileId || resolved.authProfileId
        ? { authProfileId: params.authProfileId ?? resolved.authProfileId }
        : {}),
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
  const store = (params.state.store ??=
    params.state.getStore?.() ??
    ensureAuthProfileStoreWithoutExternalProfiles(params.state.agentDir, {
      allowKeychainPrompt: false,
    }));
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
  getStore?: () => AuthStore;
  store?: AuthStore;
  agentDir?: string;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  providerOnly?: boolean;
  onError?: (provider: UsageProviderId, error: unknown) => void;
}): Promise<ProviderAuth[]> {
  if (params.auth) {
    return params.auth;
  }

  const stateBase = {
    cfg: params.config ?? getRuntimeConfig(),
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    providerOnly: params.providerOnly,
  };
  const authProfileSourceState: UsageAuthState = {
    ...stateBase,
    allowAuthProfileStore: true,
    getStore: params.getStore,
    store: params.store,
  };
  // Credential-source gate (#69479): resolving plugin usage auth imports the
  // provider plugin's runtime, so a provider with no config/env/profile-store
  // credential source must be skipped before that import — otherwise every
  // usage read cold-loads plugin runtime just to learn there is nothing to auth.
  // A caller-prepared store is itself the source; only probe disk without one.
  const hasAuthProfileStoreSource =
    params.store !== undefined ||
    params.getStore !== undefined ||
    hasAnyAuthProfileStoreSource(params.agentDir);
  const auths: ProviderAuth[] = [];
  const appendAuth = (auth: ProviderAuth) => {
    if (params.providerOnly) {
      auths.push(auth);
      return;
    }
    const { authProfileId: _authProfileId, ...publicAuth } = auth;
    auths.push(publicAuth);
  };

  for (const provider of params.providers) {
    try {
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
        ...authProfileSourceState,
        allowAuthProfileStore,
      };
      const hasPluginCredentialSource = hasDirectCredentialSource || allowAuthProfileStore;

      if (hasPluginCredentialSource) {
        const pluginAuth = await resolveProviderUsageAuthViaPlugin({
          state,
          provider,
        });
        if (pluginAuth.auth) {
          appendAuth(pluginAuth.auth);
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
        appendAuth(fallbackAuth);
      }
    } catch (error) {
      if (!params.onError) {
        throw error;
      }
      params.onError(provider, error);
    }
  }

  return auths;
}
