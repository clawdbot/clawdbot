import {
  dedupeProfileIds,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import {
  isActivatedManifestOwner,
  passesManifestOwnerBasePolicy,
} from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { resolveProviderUsageAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveProviderAuthEnvVarCandidates } from "../secrets/provider-env-vars.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { resolveLegacyPiAgentAccessToken } from "./provider-usage.shared.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
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

function resolveProviderApiKeyFromConfigAndStore(params: {
  state: UsageAuthState;
  providerIds: string[];
  envDirect?: Array<string | undefined>;
}): string | undefined {
  const configKey = resolveProviderApiKeyFromConfig(params);
  if (configKey || !params.state.allowAuthProfileStore) {
    return configKey;
  }

  const normalizedProviderIds = new Set(
    params.providerIds.map((providerId) => normalizeProviderId(providerId)).filter(Boolean),
  );
  const cred = [...normalizedProviderIds]
    .flatMap((providerId) =>
      listProfilesForProvider(resolveUsageAuthStore(params.state), providerId),
    )
    .map((id) => resolveUsageAuthStore(params.state).profiles[id])
    .find(
      (
        profile,
      ): profile is
        | { type: "api_key"; provider: string; key: string }
        | { type: "token"; provider: string; token: string } =>
        profile?.type === "api_key" || profile?.type === "token",
    );
  if (!cred) {
    return undefined;
  }
  if (cred.type === "api_key") {
    const key = normalizeSecretInput(cred.key);
    if (key && !isNonSecretApiKeyMarker(key)) {
      return key;
    }
    return undefined;
  }
  const token = normalizeSecretInput(cred.token);
  if (token && !isNonSecretApiKeyMarker(token)) {
    return token;
  }
  return undefined;
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
    const registry = loadPluginManifestRegistryForPluginRegistry({
      config: params.state.cfg,
      env: params.state.env,
      includeDisabled: true,
    });
    for (const plugin of registry.plugins) {
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
}): Promise<ProviderAuth | null> {
  const resolved = await resolveProviderUsageAuthWithPlugin({
    provider: params.provider,
    config: params.state.cfg,
    env: params.state.env,
    context: {
      config: params.state.cfg,
      agentDir: params.state.agentDir,
      env: params.state.env,
      provider: params.provider,
      resolveApiKeyFromConfigAndStore: (options) =>
        resolveProviderApiKeyFromConfigAndStore({
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
            }
          : null;
      },
    },
  });
  if (!resolved?.token) {
    return null;
  }
  return {
    provider: params.provider,
    token: resolved.token,
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
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
        return cred?.type === "api_key" || cred?.type === "oauth" || cred?.type === "token";
      })
    ) {
      return true;
    }
  }
  return false;
}

function resolveLegacyPiAgentProviderIds(provider: UsageProviderId): string[] {
  return provider === "zai" ? ["z-ai", "zai"] : [provider];
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
  const hasAuthProfileStoreSource = hasAnyAuthProfileStoreSource(params.agentDir);
  const authProfileSourceState: UsageAuthState = {
    ...stateBase,
    allowAuthProfileStore: true,
  };
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
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
      });
    const allowAuthProfileStore =
      !params.skipPluginAuthWithoutCredentialSource ||
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
    const hasLegacyPiAgentCredentialSource = Boolean(
      resolveLegacyPiAgentAccessToken(stateBase.env, resolveLegacyPiAgentProviderIds(provider)),
    );
    const hasPluginCredentialSource =
      hasDirectCredentialSource || allowAuthProfileStore || hasLegacyPiAgentCredentialSource;

    if (!params.skipPluginAuthWithoutCredentialSource || hasPluginCredentialSource) {
      const pluginAuth = await resolveProviderUsageAuthViaPlugin({
        state,
        provider,
      });
      if (pluginAuth) {
        auths.push(pluginAuth);
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
