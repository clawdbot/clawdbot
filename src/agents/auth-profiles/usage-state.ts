import { normalizeProviderId } from "../provider-id.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";

export function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "openrouter" || normalized === "kilocode";
}

export function resolveProfileUnusableUntil(
  stats: Pick<ProfileUsageStats, "cooldownUntil" | "disabledUntil">,
): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
}

export function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  return typeof until === "number" && Number.isFinite(until) && until > 0 && now < until;
}

export function shouldBypassModelScopedCooldown(
  stats: Pick<ProfileUsageStats, "cooldownReason" | "cooldownModel" | "disabledUntil">,
  now: number,
  forModel?: string,
): boolean {
  return !!(
    forModel &&
    stats.cooldownReason === "rate_limit" &&
    stats.cooldownModel &&
    stats.cooldownModel !== forModel &&
    !isActiveUnusableWindow(stats.disabledUntil, now)
  );
}

/**
 * Check if a profile is currently in cooldown (due to rate limits, overload, or other transient failures).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  now?: number,
  forModel?: string,
): boolean {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return false;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return false;
  }
  const ts = now ?? Date.now();
  // Model-aware bypass: if the cooldown was caused by a rate_limit on a
  // specific model and the caller is requesting a *different* model, allow it.
  // We still honour any active billing/auth disable (`disabledUntil`) — those
  // are profile-wide and must not be short-circuited by model scoping.
  if (shouldBypassModelScopedCooldown(stats, ts, forModel)) {
    return false;
  }
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil ? ts < unusableUntil : false;
}

/**
 * Return the soonest `unusableUntil` timestamp (ms epoch) among the given
 * profiles, or `null` when no profile has a recorded cooldown. Note: the
 * returned timestamp may be in the past if the cooldown has already expired.
 */
export function getSoonestCooldownExpiry(
  store: AuthProfileStore,
  profileIds: string[],
  options?: { now?: number; forModel?: string },
): number | null {
  const ts = options?.now ?? Date.now();
  let soonest: number | null = null;
  let latestMatchingModelCooldown: number | null = null;
  for (const id of profileIds) {
    const stats = store.usageStats?.[id];
    if (!stats) {
      continue;
    }
    if (shouldBypassModelScopedCooldown(stats, ts, options?.forModel)) {
      continue;
    }
    const until = resolveProfileUnusableUntil(stats);
    if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) {
      continue;
    }
    const matchingModelScopedCooldown =
      options?.forModel &&
      stats.cooldownReason === "rate_limit" &&
      stats.cooldownModel === options.forModel &&
      !isActiveUnusableWindow(stats.disabledUntil, ts);
    if (matchingModelScopedCooldown) {
      latestMatchingModelCooldown =
        latestMatchingModelCooldown === null ? until : Math.max(latestMatchingModelCooldown, until);
      continue;
    }
    if (soonest === null || until < soonest) {
      soonest = until;
    }
  }
  if (soonest === null) {
    return latestMatchingModelCooldown;
  }
  if (latestMatchingModelCooldown === null) {
    return soonest;
  }
  return Math.min(soonest, latestMatchingModelCooldown);
}

/**
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open -> closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown -- the root cause of profiles appearing "stuck" after rate limits.
 *
 * `cooldownUntil` and `disabledUntil` are handled independently: if a profile
 * has both and only one has expired, only that field is cleared.
 *
 * Mutates the in-memory store; disk persistence happens lazily on the next
 * store write (e.g. `markAuthProfileUsed` / `markAuthProfileFailure`), which
 * matches the existing save pattern throughout the auth-profiles module.
 *
 * @returns `true` if any profile was modified.
 */
export function clearExpiredCooldowns(store: AuthProfileStore, now?: number): boolean {
  const usageStats = store.usageStats;
  if (!usageStats) {
    return false;
  }

  const ts = now ?? Date.now();
  let mutated = false;

  for (const [profileId, stats] of Object.entries(usageStats)) {
    if (!stats) {
      continue;
    }

    let profileMutated = false;
    const cooldownExpired =
      typeof stats.cooldownUntil === "number" &&
      Number.isFinite(stats.cooldownUntil) &&
      stats.cooldownUntil > 0 &&
      ts >= stats.cooldownUntil;
    const disabledExpired =
      typeof stats.disabledUntil === "number" &&
      Number.isFinite(stats.disabledUntil) &&
      stats.disabledUntil > 0 &&
      ts >= stats.disabledUntil;

    if (cooldownExpired) {
      stats.cooldownUntil = undefined;
      stats.cooldownReason = undefined;
      stats.cooldownModel = undefined;
      profileMutated = true;
    }
    if (disabledExpired) {
      stats.disabledUntil = undefined;
      stats.disabledReason = undefined;
      profileMutated = true;
    }

    // Reset error counters when ALL cooldowns have expired so the profile gets
    // a fair retry window. Preserves lastFailureAt for the failureWindowMs
    // decay check in computeNextProfileUsageStats.
    if (profileMutated && !resolveProfileUnusableUntil(stats)) {
      stats.errorCount = 0;
      stats.failureCounts = undefined;
    }

    if (profileMutated) {
      usageStats[profileId] = stats;
      mutated = true;
    }
  }

  return mutated;
}
