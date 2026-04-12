import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import {
  evaluateStoredCredentialEligibility,
  type AuthCredentialReasonCode,
} from "./credential-state.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profiles.js";
import type { AuthProfileStore } from "./types.js";
import {
  clearExpiredCooldowns,
  isProfileInCooldown,
  resolveProfileUnusableUntil,
} from "./usage.js";

export type AuthProfileEligibilityReasonCode =
  | AuthCredentialReasonCode
  | "profile_missing"
  | "provider_mismatch"
  | "mode_mismatch";

export type AuthProfileEligibility = {
  eligible: boolean;
  reasonCode: AuthProfileEligibilityReasonCode;
};

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
    return { eligible: false, reasonCode: "profile_missing" };
  }
  if (resolveProviderIdForAuth(cred.provider, { config: params.cfg }) !== providerAuthKey) {
    return { eligible: false, reasonCode: "provider_mismatch" };
  }
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig) {
    if (
      resolveProviderIdForAuth(profileConfig.provider, { config: params.cfg }) !== providerAuthKey
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

export function resolveAuthProfileOrder(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile } = params;
  const providerKey = normalizeProviderId(provider);
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
  const now = Date.now();

  // Clear any cooldowns that have expired since the last check so profiles
  // get a fresh error count and are not immediately re-penalized on the
  // next transient failure. See #3604.
  clearExpiredCooldowns(store, now);
  const storedOrder = findNormalizedProviderValue(store.order, providerKey);
  const configuredOrder = findNormalizedProviderValue(cfg?.auth?.order, providerKey);
  const explicitOrder = storedOrder ?? configuredOrder;
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(
          ([, profile]) =>
            resolveProviderIdForAuth(profile.provider, { config: cfg }) === providerAuthKey,
        )
        .map(([profileId]) => profileId)
    : [];
  const baseOrder =
    explicitOrder ??
    (explicitProfiles.length > 0 ? explicitProfiles : listProfilesForProvider(store, provider));
  if (baseOrder.length === 0) {
    return [];
  }

  const isValidProfile = (profileId: string): boolean =>
    resolveAuthProfileEligibility({
      cfg,
      store,
      provider,
      profileId,
      now,
    }).eligible;
  let filtered = baseOrder.filter(isValidProfile);

  // Repair config/store profile-id drift from older setup flows:
  // if configured profile ids no longer exist in auth-profiles.json, scan the
  // provider's stored credentials and use any valid entries.
  const allBaseProfilesMissing = baseOrder.every((profileId) => !store.profiles[profileId]);
  if (filtered.length === 0 && explicitProfiles.length > 0 && allBaseProfilesMissing) {
    const storeProfiles = listProfilesForProvider(store, provider);
    filtered = storeProfiles.filter(isValidProfile);
  }

  const deduped = dedupeProfileIds(filtered);

  // If user specified explicit order (store override or config), respect it
  // exactly, but still apply cooldown sorting to avoid repeatedly selecting
  // known-bad/rate-limited keys as the first candidate.
  if (explicitOrder && explicitOrder.length > 0) {
    // ...but still respect cooldown tracking to avoid repeatedly selecting a
    // known-bad/rate-limited key as the first candidate.
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      if (isProfileInCooldown(store, profileId)) {
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

    // Still put preferredProfile first if specified
    if (preferredProfile && ordered.includes(preferredProfile)) {
      return [preferredProfile, ...ordered.filter((e) => e !== preferredProfile)];
    }
    return ordered;
  }

  // Otherwise, use round-robin: sort by lastUsed (oldest first)
  // preferredProfile goes first if specified (for explicit user choice)
  // lastGood is NOT prioritized - that would defeat round-robin
  const sorted = orderProfilesByMode(deduped, store);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}

function orderProfilesByMode(order: string[], store: AuthProfileStore): string[] {
  const now = Date.now();

  // Partition into available and in-cooldown
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId)) {
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
