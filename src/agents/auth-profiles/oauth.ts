/**
 * Auth profile API-key/OAuth runtime resolver.
 * Converts selected auth profiles into provider API keys, refreshes OAuth
 * credentials, resolves SecretRefs, and maintains runtime store snapshots.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProviderId,
} from "../../llm/oauth.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { resolveAuthProfileSecretOwnerId } from "../../secrets/runtime-auth-profile-owner.js";
import {
  findActiveDegradedSecretOwner,
  SecretSurfaceUnavailableError,
} from "../../secrets/runtime-degraded-state.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import {
  evaluateStoredCredentialEligibility,
  resolveTokenExpiryState,
} from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { readExternalCliBootstrapCredential } from "./external-cli-sync.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { clearLastGoodProfileWithLock } from "./profiles.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProviderId =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProviderId | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(
  provider: string,
  credentials: OAuthCredential,
  context: { cfg?: OpenClawConfig },
): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    config: context.cfg,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

type ResolveApiKeyForProfileResult = {
  apiKey: string;
  provider: string;
  email?: string;
  profileId: string;
  profileType: AuthProfileCredential["type"];
  credential?: AuthProfileCredential;
};

function buildApiKeyProfileResult(params: {
  apiKey: string;
  provider: string;
  email?: string;
  profileId: string;
  profileType: AuthProfileCredential["type"];
  credential?: AuthProfileCredential;
}): ResolveApiKeyForProfileResult {
  const result = {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
  Object.defineProperties(result, {
    profileId: {
      value: params.profileId,
      enumerable: false,
    },
    profileType: {
      value: params.profileType,
      enumerable: false,
    },
    credential: {
      value: params.credential,
      enumerable: false,
    },
  });
  return result as ResolveApiKeyForProfileResult;
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

/** Detect provider errors caused by single-use OAuth refresh token races. */
function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
}

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forceRefresh?: boolean;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

async function refreshOAuthCredential(
  credential: OAuthCredential,
): Promise<OAuthCredentials | null> {
  const pluginRefreshed = await refreshProviderOAuthCredentialWithPlugin({
    provider: credential.provider,
    context: credential,
  });
  if (pluginRefreshed) {
    return pluginRefreshed;
  }

  if (credential.provider === "chutes") {
    // Chutes refresh shipped before provider hooks and still covers registry-load
    // windows where the synchronous hook resolver intentionally returns no owner.
    return await refreshChutesTokens({ credential });
  }

  const oauthProvider = resolveOAuthProvider(credential.provider);
  if (!oauthProvider || typeof getOAuthApiKey !== "function") {
    return null;
  }
  const result = await getOAuthApiKey(oauthProvider, {
    [credential.provider]: credential,
  });
  return result?.newCredentials ?? null;
}

/** Refresh one OAuth credential and merge provider-returned token fields. */
export async function refreshOAuthCredentialForRuntime(params: {
  credential: OAuthCredential;
}): Promise<OAuthCredential | null> {
  const refreshed = await refreshOAuthCredential(params.credential);
  return refreshed
    ? {
        ...params.credential,
        ...refreshed,
        type: "oauth",
      }
    : null;
}

const oauthManager = createOAuthManager({
  buildApiKey: buildOAuthApiKey,
  refreshCredential: refreshOAuthCredential,
  readBootstrapCredential: ({ store, profileId, credential }) =>
    readExternalCliBootstrapCredential({
      store,
      profileId,
      credential,
    }),
  isRefreshTokenReusedError,
});

/** Clear in-process OAuth refresh queues between isolated tests. */
function resetOAuthRefreshQueuesForTest(): void {
  oauthManager.resetRefreshQueuesForTest();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.oauthTestApi")] = {
    isRefreshTokenReusedError,
    resetOAuthRefreshQueuesForTest,
  };
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<ResolveApiKeyForProfileResult | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  const resolved = await oauthManager.resolveOAuthAccess({
    store,
    profileId,
    credential: cred,
    agentDir: params.agentDir,
    cfg,
    forceRefresh: params.forceRefresh,
  });
  if (!resolved) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: resolved.apiKey,
    provider: resolved.credential.provider,
    email: resolved.credential.email ?? cred.email,
    profileId,
    profileType: cred.type,
    credential: resolved.credential,
  });
}

function authProfileSecretRefKey(
  profile: AuthProfileCredential,
  defaults: SecretDefaults | undefined,
): string | undefined {
  const ref =
    profile.type === "api_key"
      ? (coerceSecretRef(profile.keyRef, defaults) ?? coerceSecretRef(profile.key, defaults))
      : profile.type === "token"
        ? (coerceSecretRef(profile.tokenRef, defaults) ?? coerceSecretRef(profile.token, defaults))
        : null;
  return ref ? secretRefKey(ref) : undefined;
}

function resolveRuntimeAuthProfile(params: {
  agentDir?: string;
  profileId: string;
  profile: AuthProfileCredential;
  defaults: SecretDefaults | undefined;
}): { profile: AuthProfileCredential; published: boolean } {
  const runtimeProfile = getRuntimeAuthProfileStoreSnapshot(params.agentDir)?.profiles[
    params.profileId
  ];
  const inputRefKey = authProfileSecretRefKey(params.profile, params.defaults);
  const runtimeRefKey = runtimeProfile
    ? authProfileSecretRefKey(runtimeProfile, params.defaults)
    : undefined;
  const published = Boolean(
    runtimeProfile &&
    (isDeepStrictEqual(runtimeProfile, params.profile) ||
      (inputRefKey &&
        runtimeRefKey === inputRefKey &&
        runtimeProfile.type === params.profile.type &&
        runtimeProfile.provider === params.profile.provider)),
  );
  let profile = params.profile;
  if (published && runtimeProfile?.type === "api_key" && params.profile.type === "api_key") {
    const value = runtimeProfile.key;
    profile = { ...params.profile, key: value };
  } else if (published && runtimeProfile?.type === "token" && params.profile.type === "token") {
    const value = runtimeProfile.token;
    profile = { ...params.profile, token: value };
  }
  return {
    profile,
    published,
  };
}

function assertRuntimeAuthProfileSecretOwnerAvailable(params: {
  agentDir?: string;
  profileId: string;
  published: boolean;
}): void {
  const degraded = findActiveDegradedSecretOwner(
    "account",
    resolveAuthProfileSecretOwnerId(params),
  );
  // Match both agent store and credential ref before applying Gateway cold state; another store
  // may reuse the profile id for unrelated credentials.
  if (degraded && params.published) {
    throw new SecretSurfaceUnavailableError(degraded);
  }
}

function throwUnmaterializedAuthProfileSecretRef(params: {
  agentDir?: string;
  profileId: string;
  pathSuffix: "key" | "token";
  ref: NonNullable<ReturnType<typeof coerceSecretRef>>;
}): never {
  throw new SecretSurfaceUnavailableError({
    ownerKind: "account",
    ownerId: resolveAuthProfileSecretOwnerId(params),
    state: "unavailable",
    paths: [`auth-profiles.${params.profileId}.${params.pathSuffix}`],
    refKeys: [secretRefKey(params.ref)],
    reason: "secret reference was not materialized by the active runtime",
  });
}

/** Resolve a selected auth profile into the provider API key string. */
export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<ResolveApiKeyForProfileResult | null> {
  const { cfg, store, profileId } = params;
  const storedProfile = store.profiles[profileId];
  if (!storedProfile) {
    return null;
  }
  const configForRefResolution = cfg ?? getRuntimeConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  const runtimeProfile = resolveRuntimeAuthProfile({
    agentDir: params.agentDir,
    profileId,
    profile: storedProfile,
    defaults: refDefaults,
  });
  const cred = runtimeProfile.profile;
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });
  if (cred.type === "api_key") {
    if (!evaluateStoredCredentialEligibility({ credential: cred }).eligible) {
      return null;
    }
    assertRuntimeAuthProfileSecretOwnerAvailable({
      agentDir: params.agentDir,
      profileId,
      published: runtimeProfile.published,
    });
    const keyRef =
      coerceSecretRef(cred.keyRef, refDefaults) ?? coerceSecretRef(cred.key, refDefaults);
    const key = normalizeOptionalSecretInput(cred.key);
    if (keyRef && (!runtimeProfile.published || !key)) {
      throwUnmaterializedAuthProfileSecretRef({
        agentDir: params.agentDir,
        profileId,
        pathSuffix: "key",
        ref: keyRef,
      });
    }
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: key,
      provider: cred.provider,
      email: cred.email,
      profileId,
      profileType: cred.type,
    });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    assertRuntimeAuthProfileSecretOwnerAvailable({
      agentDir: params.agentDir,
      profileId,
      published: runtimeProfile.published,
    });
    const tokenRef =
      coerceSecretRef(cred.tokenRef, refDefaults) ?? coerceSecretRef(cred.token, refDefaults);
    const token = normalizeOptionalSecretInput(cred.token);
    if (tokenRef && (!runtimeProfile.published || !token)) {
      throwUnmaterializedAuthProfileSecretRef({
        agentDir: params.agentDir,
        profileId,
        pathSuffix: "token",
        ref: tokenRef,
      });
    }
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: token,
      provider: cred.provider,
      email: cred.email,
      profileId,
      profileType: cred.type,
    });
  }

  try {
    const resolved = await oauthManager.resolveOAuthAccess({
      store,
      agentDir: params.agentDir,
      profileId,
      credential: cred,
      cfg,
      forceRefresh: params.forceRefresh,
    });
    if (!resolved) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: resolved.apiKey,
      provider: resolved.credential.provider,
      email: resolved.credential.email ?? cred.email,
      profileId,
      profileType: cred.type,
      credential: resolved.credential,
    });
  } catch (error) {
    let refreshedStore =
      error instanceof OAuthManagerRefreshError
        ? error.getRefreshedStore()
        : loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const surfacedCause =
      error instanceof OAuthManagerRefreshError && error.cause ? error.cause : error;
    if (isRefreshTokenReusedError(surfacedCause)) {
      const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      });
      await clearLastGoodProfileWithLock({
        provider: cred.provider,
        profileId,
        agentDir: ownerAgentDir,
      });
      if (
        params.agentDir !== ownerAgentDir &&
        hasRuntimeAuthProfileStoreSnapshot(params.agentDir)
      ) {
        const snapshot = getRuntimeAuthProfileStoreSnapshot(params.agentDir);
        const providerKey = resolveProviderIdForAuth(cred.provider);
        if (snapshot?.lastGood?.[providerKey] === profileId) {
          delete snapshot.lastGood[providerKey];
          if (Object.keys(snapshot.lastGood).length === 0) {
            snapshot.lastGood = undefined;
          }
          setRuntimeAuthProfileStoreSnapshot(snapshot, params.agentDir);
        }
      }
      refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    }
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
          forceRefresh: params.forceRefresh,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    const message = extractErrorMessage(surfacedCause);
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new OAuthRefreshFailureError({
      provider: cred.provider,
      profileId,
      message:
        `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
      cause: error,
    });
  }
}
