import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { externalCliDiscoveryForProviderAuth } from "../agents/auth-profiles/external-cli-discovery.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { listProfilesForProvider } from "../agents/auth-profiles/profiles.js";
import { resolveStoredCredentialReadOnlyAvailability } from "../agents/auth-profiles/read-only-availability.js";
import {
  ensureAuthProfileStore,
  findPersistedAuthProfileCredential,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileStore, AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import {
  profileTypeToAuthMode,
  resolveDirectProviderCredentialMode,
  resolveProviderConfig,
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../agents/model-auth-provider-config.js";
import { resolveManagedSecretRefRuntimeProviderAuth } from "../agents/model-auth-runtime-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Checks whether a provider has usable config/env auth or matching local auth profiles.
 */
export function isProviderApiKeyConfigured(params: {
  /** Provider id to check for config/env auth or local auth profiles. */
  provider: string;
  /** Optional runtime config used to resolve provider-owned API-key credentials. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Optional provider-owned acceptance predicate for a known selected credential. */
  acceptsApiKey?: (apiKey: string) => boolean;
}): boolean {
  const agentDir = params.agentDir?.trim();
  if (params.acceptsApiKey) {
    const { acceptsApiKey, ...availability } = params;
    if (!isProviderApiKeyConfigured(availability)) {
      return false;
    }

    const providerConfig = resolveProviderConfig(params.cfg, params.provider);
    const authoredApiKey = providerConfig?.apiKey;
    const store = agentDir
      ? ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false })
      : undefined;
    let profile =
      typeof authoredApiKey === "string" ? store?.profiles[authoredApiKey.trim()] : undefined;
    if (!profile && store && providerConfig?.auth !== "api-key") {
      const [profileId] = listUsableProviderAuthProfileIds(availability).profileIds;
      profile = profileId ? store.profiles[profileId] : undefined;
    }
    if (profile) {
      const credential =
        profile.type === "oauth"
          ? profile.access
          : profile.type === "token"
            ? (profile.token ??
              (profile.tokenRef?.source === "env" ? process.env[profile.tokenRef.id] : undefined))
            : (profile.key ??
              (profile.keyRef?.source === "env" ? process.env[profile.keyRef.id] : undefined));
      // Opaque managed profile refs are validated after canonical async auth resolution.
      return credential === undefined || acceptsApiKey(credential);
    }

    const configParams = { cfg: params.cfg, provider: params.provider };
    const configKey =
      resolveManagedSecretRefRuntimeProviderAuth(configParams)?.apiKey ??
      resolveUsableCustomProviderApiKey(configParams)?.apiKey;
    const selectedKey =
      providerConfig?.auth === "api-key" && authoredApiKey !== undefined
        ? configKey
        : (resolveEnvApiKey(params.provider, process.env, { config: params.cfg })?.apiKey ??
          configKey);
    return selectedKey === undefined || acceptsApiKey(selectedKey);
  }

  if (params.cfg) {
    // Capability discovery must reject synthetic auth markers and unresolved
    // SecretRefs that the provider's runtime cannot actually authenticate with.
    const allowsCredentialMode = (mode: ReturnType<typeof profileTypeToAuthMode>) =>
      !params.profileTypes?.length ||
      params.profileTypes.some((profileType) => profileTypeToAuthMode(profileType) === mode);
    const authoredApiKey = resolveProviderConfig(params.cfg, params.provider)?.apiKey;
    const profileId = typeof authoredApiKey === "string" ? authoredApiKey.trim() : undefined;
    if (agentDir && profileId) {
      const credential = findPersistedAuthProfileCredential({ agentDir, profileId });
      if (credential) {
        const binding = resolveProviderEntryApiKeyProfileReference({
          cfg: params.cfg,
          provider: params.provider,
          store: { version: 1, profiles: { [profileId]: credential } },
        });
        if (binding.kind === "profile-incompatible") {
          return false;
        }
        if (binding.kind === "profile") {
          return (
            allowsCredentialMode(binding.mode) &&
            resolveStoredCredentialReadOnlyAvailability({
              credential: binding.credential,
              cfg: params.cfg,
              env: process.env,
            }) === true
          );
        }
      }
    }
    const configured = resolveUsableCustomProviderApiKey({
      cfg: params.cfg,
      provider: params.provider,
    });
    if (
      configured?.apiKey &&
      !isNonSecretApiKeyMarker(configured.apiKey) &&
      allowsCredentialMode(
        resolveDirectProviderCredentialMode({
          cfg: params.cfg,
          provider: params.provider,
          inferredMode: "api-key",
        }),
      )
    ) {
      return true;
    }
    const managed = resolveManagedSecretRefRuntimeProviderAuth({
      cfg: params.cfg,
      provider: params.provider,
    });
    if (managed?.apiKey && allowsCredentialMode(managed.mode)) {
      return true;
    }
  }
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  if (!agentDir) {
    return false;
  }
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds = listProfilesForProvider(store, params.provider);
  if (!params.profileTypes?.length) {
    return profileIds.length > 0;
  }
  const allowedTypes = new Set(params.profileTypes);
  return profileIds.some((profileId) => {
    const type = store.profiles[profileId]?.type;
    return type !== undefined && allowedTypes.has(type);
  });
}

/**
 * Lists auth profile ids usable for a provider without throwing on missing stores or keychain access.
 */
export function listUsableProviderAuthProfileIds(params: {
  /** Provider id whose usable auth profiles should be listed. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and default agent dir. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): { agentDir: string; profileIds: string[] } {
  try {
    const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
    return { agentDir, profileIds: filterAuthProfileIdsByType(store, profileIds, params) };
  } catch {
    return { agentDir: "", profileIds: [] };
  }
}

/**
 * Checks whether any usable auth profile exists for a provider.
 */
export function isProviderAuthProfileConfigured(params: {
  /** Provider id to check for usable auth profiles. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and default agent dir. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): boolean {
  return listUsableProviderAuthProfileIds(params).profileIds.length > 0;
}

/**
 * Resolves the first usable auth-profile API key for a provider in configured profile order.
 */
export async function resolveProviderAuthProfileApiKey(params: {
  /** Provider id whose first usable auth profile should resolve to an API key. */
  provider: string;
  /** Optional runtime config used to resolve auth profile order and secret refs. */
  cfg?: OpenClawConfig;
  /** Agent directory containing auth profiles. */
  agentDir?: string;
  /** Optional allowed profile credential types. */
  profileTypes?: readonly AuthProfileCredential["type"][];
  /** Whether profile store reads may prompt for keychain-backed credentials. */
  allowKeychainPrompt?: boolean;
  /** Whether external CLI auth profiles may be discovered and included. */
  includeExternalCliAuth?: boolean;
}): Promise<string | undefined> {
  const { resolveApiKeyForProfile } = await import("../agents/auth-profiles/oauth.js");
  const { agentDir, profileIds, store } = resolveUsableProviderAuthProfiles(params);
  if (!agentDir || profileIds.length === 0) {
    return undefined;
  }
  for (const profileId of filterAuthProfileIdsByType(store, profileIds, params)) {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      agentDir,
      profileId,
    });
    if (resolved?.apiKey) {
      return resolved.apiKey;
    }
  }
  return undefined;
}

function resolveUsableProviderAuthProfiles(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  allowKeychainPrompt?: boolean;
  includeExternalCliAuth?: boolean;
}): { agentDir: string; profileIds: string[]; store: AuthProfileStore } {
  const agentDir = params.agentDir?.trim() || resolveDefaultAgentDir(params.cfg ?? {});
  const externalCli = params.includeExternalCliAuth
    ? externalCliDiscoveryForProviderAuth({
        cfg: params.cfg,
        provider: params.provider,
        allowKeychainPrompt: params.allowKeychainPrompt,
      })
    : undefined;
  const store = externalCli
    ? loadAuthProfileStoreForSecretsRuntime(agentDir, { externalCli })
    : loadAuthProfileStoreForSecretsRuntime(agentDir);
  const profileIds = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  if (profileIds.length > 0) {
    return { agentDir, profileIds, store };
  }

  const fallbackStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: params.allowKeychainPrompt ?? false,
  });
  return {
    agentDir,
    profileIds: resolveAuthProfileOrder({
      cfg: params.cfg,
      store: fallbackStore,
      provider: params.provider,
    }),
    store: fallbackStore,
  };
}

function filterAuthProfileIdsByType(
  store: AuthProfileStore,
  profileIds: readonly string[],
  params: { profileTypes?: readonly AuthProfileCredential["type"][] },
): string[] {
  if (!params.profileTypes?.length) {
    return [...profileIds];
  }
  const allowedTypes = new Set(params.profileTypes);
  return profileIds.filter((profileId) => {
    const type = store.profiles[profileId]?.type;
    return type !== undefined && allowedTypes.has(type);
  });
}
