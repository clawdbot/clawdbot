/**
 * Auth profile ordering and eligibility.
 * Resolves configured/stored auth order, provider aliases, cooldowns, and
 * profile compatibility for provider auth selection.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../provider-auth-aliases.js";
import {
  evaluateStoredCredentialEligibility,
  type AuthCredentialReasonCode,
} from "./credential-state.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
  resolveProfileUnusableUntil,
} from "./usage-state.js";

/** Reason a profile is or is not eligible for provider auth. */
export type AuthProfileEligibilityReasonCode =
  | AuthCredentialReasonCode
  | "profile_missing"
  | "provider_mismatch"
  | "mode_mismatch";

/** Eligibility decision for one auth profile candidate. */
type AuthProfileEligibility = {
  eligible: boolean;
  reasonCode: AuthProfileEligibilityReasonCode;
};

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai";

// OpenAI Codex auth can reuse OpenAI API-key credentials. Keep this special
// case local so generic provider alias resolution stays provider-owned.
function isOpenAIApiKeyCompatibleWithCodexAuth(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  providerAuthKey: string;
  credential?: AuthProfileCredential;
  profileProvider?: string;
  profileMode?: string;
}): boolean {
  if (params.providerAuthKey !== OPENAI_CODEX_PROVIDER_ID) {
    return false;
  }
  const providerKey = resolveProviderIdForAuth(params.profileProvider ?? "", {
    config: params.cfg,
    ...params.authAliasLookupParams,
  });
  const mode = params.credential?.type ?? params.profileMode;
  return providerKey === OPENAI_PROVIDER_ID && mode === "api_key";
}

function isCredentialProviderCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  providerAuthKey: string;
  credential: AuthProfileCredential;
}): boolean {
  const credentialProviderKey = resolveProviderIdForAuth(params.credential.provider, {
    config: params.cfg,
    ...params.authAliasLookupParams,
  });
  return (
    credentialProviderKey === params.providerAuthKey ||
    isOpenAIApiKeyCompatibleWithCodexAuth({
      cfg: params.cfg,
      authAliasLookupParams: params.authAliasLookupParams,
      providerAuthKey: params.providerAuthKey,
      credential: params.credential,
      profileProvider: params.credential.provider,
    })
  );
}

/** Returns true when a stored credential can authenticate the requested provider. */
export function isStoredCredentialCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  provider: string;
  credential: AuthProfileCredential;
}): boolean {
  return isCredentialProviderCompatibleWithAuthProvider({
    cfg: params.cfg,
    authAliasLookupParams: params.authAliasLookupParams,
    providerAuthKey: resolveProviderIdForAuth(params.provider, {
      config: params.cfg,
      ...params.authAliasLookupParams,
    }),
    credential: params.credential,
  });
}

function isConfiguredProfileCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  providerAuthKey: string;
  provider: string;
  mode?: string;
  credential?: AuthProfileCredential;
}): boolean {
  const configProviderKey = resolveProviderIdForAuth(params.provider, { config: params.cfg });
  return (
    configProviderKey === params.providerAuthKey ||
    isOpenAIApiKeyCompatibleWithCodexAuth({
      cfg: params.cfg,
      providerAuthKey: params.providerAuthKey,
      credential: params.credential,
      profileProvider: params.provider,
      profileMode: params.mode,
    })
  );
}

function listProfilesCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  providerAuthKey: string;
}): string[] {
  if (params.providerAuthKey !== OPENAI_CODEX_PROVIDER_ID) {
    return listProfilesForProvider(params.store, params.provider);
  }
  return Object.entries(params.store.profiles)
    .filter(([, credential]) =>
      isCredentialProviderCompatibleWithAuthProvider({
        cfg: params.cfg,
        providerAuthKey: params.providerAuthKey,
        credential,
      }),
    )
    .map(([profileId]) => profileId);
}

function resolveProviderAuthMode(
  cfg: OpenClawConfig | undefined,
  provider: string,
): string | undefined {
  const providers = cfg?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const entry = findNormalizedProviderValue(providers, provider);
  const auth = entry?.auth;
  return typeof auth === "string" ? auth : undefined;
}

function providerAllowsAwsSdkAuth(cfg: OpenClawConfig | undefined, provider: string): boolean {
  const authMode = resolveProviderAuthMode(cfg, provider);
  return authMode === "aws-sdk";
}

/** Returns true when config declares an aws-sdk auth profile for a provider. */
export function isConfiguredAwsSdkAuthProfileForProvider(params: {
  cfg?: OpenClawConfig;
  provider: string;
  profileId: string;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (!profileConfig || profileConfig.mode !== "aws-sdk") {
    return false;
  }
  const providerAuthKey = resolveProviderIdForAuth(params.provider, { config: params.cfg });
  if (
    resolveProviderIdForAuth(profileConfig.provider, { config: params.cfg }) !== providerAuthKey
  ) {
    return false;
  }
  return providerAllowsAwsSdkAuth(params.cfg, params.provider);
}

/** Resolves whether a profile can be used for a provider right now. */
export function resolveAuthProfileEligibility(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  now?: number;
}): AuthProfileEligibility {
  const providerAuthKey = resolveProviderIdForAuth(params.provider, { config: params.cfg });
  const cred = params.store.profiles[params.profileId];
  if (!cred) {
    if (
      isConfiguredAwsSdkAuthProfileForProvider({
        cfg: params.cfg,
        provider: params.provider,
        profileId: params.profileId,
      })
    ) {
      return { eligible: true, reasonCode: "ok" };
    }
    return { eligible: false, reasonCode: "profile_missing" };
  }
  if (
    !isCredentialProviderCompatibleWithAuthProvider({
      cfg: params.cfg,
      providerAuthKey,
      credential: cred,
    })
  ) {
    return { eligible: false, reasonCode: "provider_mismatch" };
  }
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig) {
    if (
      !isConfiguredProfileCompatibleWithAuthProvider({
        cfg: params.cfg,
        providerAuthKey,
        provider: profileConfig.provider,
        mode: profileConfig.mode,
        credential: cred,
      })
    ) {
      return { eligible: false, reasonCode: "provider_mismatch" };
    }
    if (profileConfig.mode !== cred.type) {
      const oauthCompatible = profileConfig.mode === "oauth" && cred.type === "token";
      if (!oauthCompatible) {
        return { eligible: false, reasonCode: "mode_mismatch" };
      }
    }
  }
  const credentialEligibility = evaluateStoredCredentialEligibility({
    credential: cred,
    now: params.now,
  });
  return {
    eligible: credentialEligibility.eligible,
    reasonCode: credentialEligibility.reasonCode,
  };
}

export type ResolveAuthProfileOrderParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
  /** Model that will consume the profile, for model-scoped cooldowns. */
  forModel?: string;
  /** Read-only status keeps unresolved refs ordered so availability remains unknown. */
  readinessMode?: "execution" | "read-only";
};

export type AuthProfileOrderResolution = {
  profileIds: string[];
  /** An authored store/config order owns selection, including an empty result. */
  hasExplicitOrder: boolean;
};

/** Resolves ordered usable auth profiles plus whether an explicit order owns selection. */
export function resolveAuthProfileOrderWithMetadata(
  params: ResolveAuthProfileOrderParams,
): AuthProfileOrderResolution {
  const { cfg, store, provider, preferredProfile, forModel } = params;
  const providerKey = normalizeProviderId(provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
  const now = Date.now();

  // Clear any cooldowns that have expired since the last check so profiles
  // get a fresh error count and are not immediately re-penalized on the
  // next transient failure. See #3604.
  clearExpiredCooldowns(store, now);
  const openAIOrderAliasProvider =
    providerAuthKey === OPENAI_CODEX_PROVIDER_ID || providerKey === OPENAI_CODEX_PROVIDER_ID
      ? OPENAI_PROVIDER_ID
      : undefined;
  const directStoredOrder =
    resolveAuthOrder(store.order, providerAuthKey) ?? resolveAuthOrder(store.order, providerKey);
  const aliasStoredOrder = openAIOrderAliasProvider
    ? resolveAuthOrder(store.order, openAIOrderAliasProvider)
    : undefined;
  const directConfiguredOrder =
    resolveAuthOrder(cfg?.auth?.order, providerAuthKey) ??
    resolveAuthOrder(cfg?.auth?.order, providerKey);
  const aliasConfiguredOrder = openAIOrderAliasProvider
    ? resolveAuthOrder(cfg?.auth?.order, openAIOrderAliasProvider)
    : undefined;
  const directExplicitOrder = directStoredOrder ?? directConfiguredOrder;
  const aliasExplicitOrder = aliasStoredOrder ?? aliasConfiguredOrder;
  // Stored order repairs are allowed to fall back to live store profiles when
  // old setup flows persisted profile ids that no longer exist.
  const explicitOrderFromStore =
    directStoredOrder !== undefined ||
    (directExplicitOrder === undefined && aliasStoredOrder !== undefined);
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([profileId, profile]) =>
          isConfiguredProfileCompatibleWithAuthProvider({
            cfg,
            providerAuthKey,
            provider: profile.provider,
            mode: profile.mode,
            credential: store.profiles[profileId],
          }),
        )
        .map(([profileId]) => profileId)
    : [];
  const storeProfiles = listProfilesCompatibleWithAuthProvider({
    cfg,
    store,
    provider,
    providerAuthKey,
  });
  const nativeStoreProfiles =
    openAIOrderAliasProvider && providerAuthKey === OPENAI_CODEX_PROVIDER_ID
      ? storeProfiles.filter((profileId) =>
          isNativeCredentialProviderCompatibleWithAuthProvider({
            cfg,
            providerAuthKey,
            credential: store.profiles[profileId],
          }),
        )
      : [];
  const explicitOrder =
    directExplicitOrder ??
    (aliasExplicitOrder
      ? mergeAliasOrderWithNativeProfiles({
          aliasOrder: aliasExplicitOrder,
          nativeProfiles: nativeStoreProfiles,
        })
      : undefined);
  const baseOrder =
    explicitOrder ?? (explicitProfiles.length > 0 ? explicitProfiles : storeProfiles);
  if (baseOrder.length === 0) {
    return { profileIds: [], hasExplicitOrder: explicitOrder !== undefined };
  }

  const isValidProfile = (profileId: string): boolean => {
    const eligibility = resolveAuthProfileEligibility({
      cfg,
      store,
      provider,
      profileId,
      now,
    });
    return (
      eligibility.eligible ||
      (params.readinessMode === "read-only" && eligibility.reasonCode === "unresolved_ref")
    );
  };
  let filtered = baseOrder.filter(isValidProfile);
  let repairedFallbackToStoreProfiles = false;

  // Repair stored-order and config-profile drift from older setup flows:
  // bare config auth.order is a hard constraint, but configured profile ids
  // can drift from their stored credential ids and still need repair.
  const allBaseProfilesMissing = baseOrder.every((profileId) => !store.profiles[profileId]);
  if (
    filtered.length === 0 &&
    allBaseProfilesMissing &&
    (explicitOrderFromStore || explicitProfiles.length > 0)
  ) {
    filtered = storeProfiles.filter(isValidProfile);
    repairedFallbackToStoreProfiles = true;
  }

  const deduped = dedupeProfileIds(filtered);

  // Explicit order remains a hard user/config preference, but cooldown tracking
  // moves temporarily bad profiles behind available ones.
  if (explicitOrder && explicitOrder.length > 0 && !repairedFallbackToStoreProfiles) {
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      if (isProfileInCooldown(store, profileId, now, forModel)) {
        const cooldownUntil =
          resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now;
        inCooldown.push({ profileId, cooldownUntil });
      } else {
        available.push(profileId);
      }
    }

    const cooldownSorted = inCooldown
      .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
      .map((entry) => entry.profileId);

    const ordered = [...available, ...cooldownSorted];

    // Explicit user choice still wins when it is part of the filtered order.
    if (preferredProfile && ordered.includes(preferredProfile)) {
      return {
        profileIds: [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)],
        hasExplicitOrder: true,
      };
    }
    return { profileIds: ordered, hasExplicitOrder: true };
  }

  // Otherwise, use round-robin by lastUsed. lastGood is intentionally ignored
  // because prioritizing it would starve other healthy profiles.
  const sorted = orderProfilesByMode(deduped, store, now, forModel);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return {
      profileIds: [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)],
      hasExplicitOrder: explicitOrder !== undefined,
    };
  }

  return { profileIds: sorted, hasExplicitOrder: explicitOrder !== undefined };
}

/** Resolves ordered usable auth profile ids for a provider. */
export function resolveAuthProfileOrder(params: ResolveAuthProfileOrderParams): string[] {
  return resolveAuthProfileOrderWithMetadata(params).profileIds;
}

function resolveAuthOrder(
  order: Record<string, string[]> | undefined,
  provider: string,
): string[] | undefined {
  return findNormalizedProviderValue(order, provider);
}

function isNativeCredentialProviderCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  providerAuthKey: string;
  credential: AuthProfileCredential | undefined;
}): boolean {
  if (!params.credential) {
    return false;
  }
  return (
    resolveProviderIdForAuth(params.credential.provider, { config: params.cfg }) ===
    params.providerAuthKey
  );
}

function mergeAliasOrderWithNativeProfiles(params: {
  aliasOrder: string[];
  nativeProfiles: string[];
}): string[] {
  const nativeIds = new Set(params.nativeProfiles);
  const aliasHasNativeProfile = params.aliasOrder.some((profileId) => nativeIds.has(profileId));
  return dedupeProfileIds(
    aliasHasNativeProfile
      ? [...params.aliasOrder, ...params.nativeProfiles]
      : [...params.nativeProfiles, ...params.aliasOrder],
  );
}

function orderProfilesByMode(
  order: string[],
  store: AuthProfileStore,
  now: number,
  forModel?: string,
): string[] {
  // Partition into available and in-cooldown
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId, now, forModel)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // Sort available profiles by type preference, then by lastUsed (oldest first = round-robin within type)
  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore = type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  // Primary sort: type preference (oauth > token > api_key).
  // Secondary sort: lastUsed (oldest first for round-robin within type).
  const sorted = scored
    .toSorted((a, b) => {
      // First by type (oauth > token > api_key)
      if (a.typeScore !== b.typeScore) {
        return a.typeScore - b.typeScore;
      }
      // Then by lastUsed (oldest first)
      return a.lastUsed - b.lastUsed;
    })
    .map((entry) => entry.profileId);

  // Append cooldown profiles at the end (sorted by cooldown expiry, soonest first)
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now,
    }))
    .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}
