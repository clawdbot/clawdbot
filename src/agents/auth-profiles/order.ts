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
  resolveTokenExpiryState,
  type AuthCredentialReasonCode,
} from "./credential-state.js";
import { dedupeProfileIds } from "./profile-list.js";
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

function isProfileProviderCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  providerAuthKey: string;
  provider: string;
}): boolean {
  const providerKey = resolveProviderIdForAuth(params.provider, {
    config: params.cfg,
    ...params.authAliasLookupParams,
  });
  return providerKey === params.providerAuthKey;
}

/** Returns true when a stored credential can authenticate the requested provider. */
export function isStoredCredentialCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  provider: string;
  credential: AuthProfileCredential;
}): boolean {
  return isProfileProviderCompatibleWithAuthProvider({
    cfg: params.cfg,
    authAliasLookupParams: params.authAliasLookupParams,
    providerAuthKey: resolveProviderIdForAuth(params.provider, {
      config: params.cfg,
      ...params.authAliasLookupParams,
    }),
    provider: params.credential.provider,
  });
}

function listProfilesCompatibleWithAuthProvider(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  store: AuthProfileStore;
  providerAuthKey: string;
}): string[] {
  return Object.entries(params.store.profiles)
    .filter(([, credential]) =>
      isProfileProviderCompatibleWithAuthProvider({
        cfg: params.cfg,
        authAliasLookupParams: params.authAliasLookupParams,
        providerAuthKey: params.providerAuthKey,
        provider: credential.provider,
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
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  provider: string;
  profileId: string;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (!profileConfig || profileConfig.mode !== "aws-sdk") {
    return false;
  }
  const providerAuthKey = resolveProviderIdForAuth(params.provider, {
    config: params.cfg,
    ...params.authAliasLookupParams,
  });
  if (
    resolveProviderIdForAuth(profileConfig.provider, {
      config: params.cfg,
      ...params.authAliasLookupParams,
    }) !== providerAuthKey
  ) {
    return false;
  }
  return providerAllowsAwsSdkAuth(params.cfg, providerAuthKey);
}

/** Resolves whether a profile can be used for a provider right now. */
export function resolveAuthProfileEligibility(params: {
  cfg?: OpenClawConfig;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  now?: number;
}): AuthProfileEligibility {
  const providerAuthKey = resolveProviderIdForAuth(params.provider, {
    config: params.cfg,
    ...params.authAliasLookupParams,
  });
  const cred = params.store.profiles[params.profileId];
  if (!cred) {
    if (
      isConfiguredAwsSdkAuthProfileForProvider({
        cfg: params.cfg,
        authAliasLookupParams: params.authAliasLookupParams,
        provider: params.provider,
        profileId: params.profileId,
      })
    ) {
      return { eligible: true, reasonCode: "ok" };
    }
    return { eligible: false, reasonCode: "profile_missing" };
  }
  if (
    !isProfileProviderCompatibleWithAuthProvider({
      cfg: params.cfg,
      authAliasLookupParams: params.authAliasLookupParams,
      providerAuthKey,
      provider: cred.provider,
    })
  ) {
    return { eligible: false, reasonCode: "provider_mismatch" };
  }
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig) {
    if (
      !isProfileProviderCompatibleWithAuthProvider({
        cfg: params.cfg,
        authAliasLookupParams: params.authAliasLookupParams,
        providerAuthKey,
        provider: profileConfig.provider,
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

type ResolveAuthProfileOrderParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  /** Exact prepared metadata for request paths that must not rediscover plugin aliases. */
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  preferredProfile?: string;
  /** Model that will consume the profile, for model-scoped cooldowns. */
  forModel?: string;
  /** Account-wide selection ignores windows limited to one model. */
  cooldownScope?: "all-models";
  /** Read-only status keeps unresolved refs ordered so availability remains unknown. */
  readinessMode?: "execution" | "read-only";
};

export type AuthProfileOrderResolution = {
  profileIds: string[];
  /** An authored store/config order owns selection, including an empty result. */
  hasExplicitOrder: boolean;
};

/** Session pins lead the shared order without discarding its failover candidates. */
export function prependAuthProfilePin(
  resolution: AuthProfileOrderResolution,
  profileId: string | undefined,
): AuthProfileOrderResolution {
  return profileId
    ? {
        ...resolution,
        profileIds: [profileId, ...resolution.profileIds.filter((id) => id !== profileId)],
      }
    : resolution;
}

/** Shares stored-over-config order precedence with CLI runtime selection. */
export function resolveExplicitAuthOrderSelection(params: {
  storeOrder: AuthProfileStore["order"] | undefined;
  configuredOrder: Record<string, string[]> | undefined;
  providerKey: string;
  providerAuthKey: string;
}): {
  order: string[] | undefined;
  fromStore: boolean;
} {
  const { storeOrder, configuredOrder, providerKey, providerAuthKey } = params;
  const stored =
    findNormalizedProviderValue(storeOrder, providerAuthKey) ??
    findNormalizedProviderValue(storeOrder, providerKey);
  return {
    order:
      stored ??
      findNormalizedProviderValue(configuredOrder, providerAuthKey) ??
      findNormalizedProviderValue(configuredOrder, providerKey),
    fromStore: stored !== undefined,
  };
}

/** Resolves ordered usable auth profiles plus whether an explicit order owns selection. */
export function resolveAuthProfileOrderWithMetadata(
  params: ResolveAuthProfileOrderParams,
): AuthProfileOrderResolution {
  const { cfg, store, provider, preferredProfile, forModel } = params;
  const providerKey = normalizeProviderId(provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, {
    config: cfg,
    ...params.authAliasLookupParams,
  });
  const now = Date.now();

  // Clear expired windows so profiles become eligible for a half-open probe.
  // Rate-limit counts persist until success to back off repeated failed probes;
  // other transient failures still receive a fresh counter. See #3604.
  clearExpiredCooldowns(store, now);
  const { order: explicitOrder, fromStore: explicitOrderFromStore } =
    resolveExplicitAuthOrderSelection({
      storeOrder: store.order,
      configuredOrder: cfg?.auth?.order,
      providerKey,
      providerAuthKey,
    });
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([, profile]) =>
          isProfileProviderCompatibleWithAuthProvider({
            cfg,
            authAliasLookupParams: params.authAliasLookupParams,
            providerAuthKey,
            provider: profile.provider,
          }),
        )
        .map(([profileId]) => profileId)
    : [];
  const storeProfiles = listProfilesCompatibleWithAuthProvider({
    cfg,
    authAliasLookupParams: params.authAliasLookupParams,
    store,
    providerAuthKey,
  });
  const baseOrder =
    explicitOrder ?? (explicitProfiles.length > 0 ? explicitProfiles : storeProfiles);
  if (baseOrder.length === 0) {
    return { profileIds: [], hasExplicitOrder: explicitOrder !== undefined };
  }

  const isValidProfile = (profileId: string): boolean => {
    const eligibility = resolveAuthProfileEligibility({
      cfg,
      authAliasLookupParams: params.authAliasLookupParams,
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
  const cooldownModel = params.cooldownScope === "all-models" ? null : forModel;
  const isInCooldown = (profileId: string) =>
    isProfileInCooldown(store, profileId, now, cooldownModel);
  const unusableUntil = (profileId: string) =>
    resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}, cooldownModel);

  // Explicit order remains a hard user/config preference, but cooldown tracking
  // moves temporarily bad profiles behind available ones.
  if (explicitOrder && explicitOrder.length > 0 && !repairedFallbackToStoreProfiles) {
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      if (isInCooldown(profileId)) {
        inCooldown.push({ profileId, cooldownUntil: unusableUntil(profileId) ?? now });
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
  const sorted = orderProfilesByMode(deduped, store, now, isInCooldown, unusableUntil);

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

function orderProfilesByMode(
  order: string[],
  store: AuthProfileStore,
  now: number,
  isInCooldown: (profileId: string) => boolean,
  unusableUntil: (profileId: string) => number | null,
): string[] {
  // Partition into available and in-cooldown
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isInCooldown(profileId)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // Sort by type, OAuth expiry state, then lastUsed for round-robin within each tier.
  const scored = available.map((profileId) => {
    const profile = store.profiles[profileId];
    const type = profile?.type;
    const typeScore = type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    // A refreshable expired OAuth profile remains eligible, but refreshing an
    // obsolete profile can rotate a one-time refresh token while a live peer exists.
    const expiryScore =
      profile?.type === "oauth" && resolveTokenExpiryState(profile.expires, now) === "expired"
        ? 1
        : 0;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, expiryScore, lastUsed };
  });

  // Primary sort: type preference (oauth > token > api_key).
  const sorted = scored
    .toSorted((a, b) => {
      // First by type (oauth > token > api_key)
      if (a.typeScore !== b.typeScore) {
        return a.typeScore - b.typeScore;
      }
      if (a.expiryScore !== b.expiryScore) {
        return a.expiryScore - b.expiryScore;
      }
      // Then by lastUsed (oldest first)
      return a.lastUsed - b.lastUsed;
    })
    .map((entry) => entry.profileId);

  // Append cooldown profiles at the end (sorted by cooldown expiry, soonest first)
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: unusableUntil(profileId) ?? now,
    }))
    .toSorted((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}
