import type { MoltbotConfig } from "../../config/config.js";
import { normalizeProviderId } from "../model-selection.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

/**
 * Generate a cooldown key that optionally includes the model.
 * When model is provided, cooldowns are tracked per (profile + model) combination.
 * This allows different models from the same provider to have independent cooldowns.
 */
export function cooldownKey(profileId: string, model?: string): string {
  return model ? `${profileId}:${model}` : profileId;
}

function resolveProfileUnusableUntil(stats: ProfileUsageStats): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return Math.max(...values);
}

/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 */
/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 * When model is provided, checks the per-model cooldown key.
 */
/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 * When model is provided, checks both the per-model cooldown key and the profile-level key.
 * A profile-level cooldown applies to all models (backward compatibility).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
  model?: string,
): boolean {
  const now = Date.now();

  // Check per-model cooldown first (if model provided)
  if (model) {
    const modelKey = cooldownKey(profileId, model);
    const modelStats = store.usageStats?.[modelKey];
    if (modelStats) {
      const modelUnusableUntil = resolveProfileUnusableUntil(modelStats);
      if (modelUnusableUntil && now < modelUnusableUntil) {
        return true;
      }
    }
  }

  // Also check profile-level cooldown (applies to all models)
  const profileStats = store.usageStats?.[profileId];
  if (!profileStats) return false;
  const profileUnusableUntil = resolveProfileUnusableUntil(profileStats);
  return profileUnusableUntil ? now < profileUnusableUntil : false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) return false;
      freshStore.usageStats = freshStore.usageStats ?? {};
      freshStore.usageStats[profileId] = {
        ...freshStore.usageStats[profileId],
        lastUsed: Date.now(),
        errorCount: 0,
        cooldownUntil: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
      };
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  failureWindowMs: number;
};

function resolveAuthCooldownConfig(params: {
  cfg?: MoltbotConfig;
  providerId: string;
}): ResolvedAuthCooldownConfig {
  const defaults = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    failureWindowHours: 24,
  } as const;

  const resolveHours = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  const cooldowns = params.cfg?.auth?.cooldowns;
  const billingOverride = (() => {
    const map = cooldowns?.billingBackoffHoursByProvider;
    if (!map) return undefined;
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === params.providerId) return value;
    }
    return undefined;
  })();

  const billingBackoffHours = resolveHours(
    billingOverride ?? cooldowns?.billingBackoffHours,
    defaults.billingBackoffHours,
  );
  const billingMaxHours = resolveHours(cooldowns?.billingMaxHours, defaults.billingMaxHours);
  const failureWindowHours = resolveHours(
    cooldowns?.failureWindowHours,
    defaults.failureWindowHours,
  );

  return {
    billingBackoffMs: billingBackoffHours * 60 * 60 * 1000,
    billingMaxMs: billingMaxHours * 60 * 60 * 1000,
    failureWindowMs: failureWindowHours * 60 * 60 * 1000,
  };
}

function calculateAuthProfileBillingDisableMsWithConfig(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(60_000, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const exponent = Math.min(normalized - 1, 10);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
): number | null {
  const stats = store.usageStats?.[profileId];
  if (!stats) return null;
  return resolveProfileUnusableUntil(stats);
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  const baseErrorCount = windowExpired ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = windowExpired ? {} : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  if (params.reason === "billing") {
    const billingCount = failureCounts.billing ?? 1;
    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });
    updatedStats.disabledUntil = params.now + backoffMs;
    updatedStats.disabledReason = "billing";
  } else {
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = params.now + backoffMs;
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 */
/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 * When model is provided, cooldown is tracked per (profile + model) combination.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  model?: string;
  reason: AuthProfileFailureReason;
  cfg?: MoltbotConfig;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, model, reason, agentDir, cfg } = params;
  const key = cooldownKey(profileId, model);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile) return false;
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[key] ?? {};

      const now = Date.now();
      const providerKey = normalizeProviderId(profile.provider);
      const cfgResolved = resolveAuthCooldownConfig({
        cfg,
        providerId: providerKey,
      });

      freshStore.usageStats[key] = computeNextProfileUsageStats({
        existing,
        now,
        reason,
        cfgResolved,
      });
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[key] ?? {};
  const now = Date.now();
  const providerKey = normalizeProviderId(store.profiles[profileId]?.provider ?? "");
  const cfgResolved = resolveAuthCooldownConfig({
    cfg,
    providerId: providerKey,
  });

  store.usageStats[key] = computeNextProfileUsageStats({
    existing,
    now,
    reason,
    cfgResolved,
  });
  saveAuthProfileStore(store, agentDir);
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 * Uses store lock to avoid overwriting concurrent usage updates.
 * When model is provided, cooldown is tracked per (profile + model) combination.
 */
export async function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  model?: string;
  agentDir?: string;
}): Promise<void> {
  await markAuthProfileFailure({
    store: params.store,
    profileId: params.profileId,
    model: params.model,
    reason: "unknown",
    agentDir: params.agentDir,
  });
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 * When model is provided, clears the per-model cooldown key.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  model?: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, model, agentDir } = params;
  const key = cooldownKey(profileId, model);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[key]) return false;

      freshStore.usageStats[key] = {
        ...freshStore.usageStats[key],
        errorCount: 0,
        cooldownUntil: undefined,
      };
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.usageStats?.[key]) return;

  store.usageStats[key] = {
    ...store.usageStats[key],
    errorCount: 0,
    cooldownUntil: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}
