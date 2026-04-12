import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeProviderId } from "../model-selection.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";
import { saveAuthProfileStore, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";

const authProfileUsageDeps = {
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
};

export const __testing = {
  setDepsForTest(
    overrides: Partial<{
      saveAuthProfileStore: typeof saveAuthProfileStore;
      updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
    }> | null,
  ) {
    authProfileUsageDeps.saveAuthProfileStore =
      overrides?.saveAuthProfileStore ?? saveAuthProfileStore;
    authProfileUsageDeps.updateAuthProfileStoreWithLock =
      overrides?.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  },
};

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  "auth_permanent",
  "auth",
  "billing",
  "format",
  "model_not_found",
  "overloaded",
  "timeout",
  "rate_limit",
  "unknown",
];
const FAILURE_REASON_SET = new Set<AuthProfileFailureReason>(FAILURE_REASON_PRIORITY);
const FAILURE_REASON_ORDER = new Map<AuthProfileFailureReason, number>(
  FAILURE_REASON_PRIORITY.map((reason, index) => [reason, index]),
);

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_TIMEOUT_MS = 3_000;
const WHAM_BURST_COOLDOWN_MS = 15_000;
const WHAM_PROBE_FAILURE_COOLDOWN_MS = 30_000;
const WHAM_HTTP_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const WHAM_TOKEN_EXPIRED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WHAM_DEAD_ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WHAM_TEAM_ROLLING_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const WHAM_PERSONAL_MAX_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const WHAM_TEAM_WEEKLY_MAX_COOLDOWN_MS = 4 * 60 * 60 * 1000;

type WhamUsageWindow = {
  limit_window_seconds?: number;
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
};

type WhamUsageResponse = {
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: WhamUsageWindow;
    secondary_window?: WhamUsageWindow;
  };
};

type WhamCooldownProbeResult = {
  cooldownMs: number;
  reason: string;
};

function isAuthCooldownBypassedForProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === "openrouter" || normalized === "kilocode";
}

function shouldProbeWhamForFailure(
  provider: string | undefined,
  reason: AuthProfileFailureReason,
): boolean {
  return (
    normalizeProviderId(provider ?? "") === "openai-codex" &&
    (reason === "rate_limit" || reason === "unknown")
  );
}

function resolveWhamResetMs(window: WhamUsageWindow | undefined, now: number): number | null {
  if (!window) {
    return null;
  }
  if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds) &&
    window.reset_after_seconds > 0
  ) {
    return window.reset_after_seconds * 1000;
  }
  if (
    typeof window.reset_at === "number" &&
    Number.isFinite(window.reset_at) &&
    window.reset_at > 0
  ) {
    return Math.max(0, window.reset_at * 1000 - now);
  }
  return null;
}

function isWhamWindowExhausted(window: WhamUsageWindow | undefined): boolean {
  return !!(
    window &&
    typeof window.used_percent === "number" &&
    Number.isFinite(window.used_percent) &&
    window.used_percent >= 100
  );
}

function applyWhamCooldownResult(params: {
  existing: ProfileUsageStats;
  computed: ProfileUsageStats;
  now: number;
  whamResult: WhamCooldownProbeResult;
}): ProfileUsageStats {
  const existingCooldownUntil = params.existing.cooldownUntil;
  const existingActiveCooldownUntil =
    typeof existingCooldownUntil === "number" &&
    Number.isFinite(existingCooldownUntil) &&
    existingCooldownUntil > params.now
      ? existingCooldownUntil
      : 0;
  return {
    ...params.computed,
    cooldownUntil: Math.max(existingActiveCooldownUntil, params.now + params.whamResult.cooldownMs),
  };
}

export async function probeWhamForCooldown(
  store: AuthProfileStore,
  profileId: string,
): Promise<WhamCooldownProbeResult | null> {
  const profile = store.profiles[profileId];
  if (profile?.type !== "oauth" || !profile.access) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHAM_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${profile.access}`,
      Accept: "application/json",
      "User-Agent": "CodexBar",
    };
    if (profile.accountId) {
      headers["ChatGPT-Account-Id"] = profile.accountId;
    }

    const res = await fetch(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      if (res.status === 401) {
        return { cooldownMs: WHAM_TOKEN_EXPIRED_COOLDOWN_MS, reason: "wham_token_expired" };
      }
      if (res.status === 403) {
        return { cooldownMs: WHAM_DEAD_ACCOUNT_COOLDOWN_MS, reason: "wham_account_dead" };
      }
      return { cooldownMs: WHAM_HTTP_ERROR_COOLDOWN_MS, reason: "wham_http_error" };
    }

    const data = (await res.json()) as WhamUsageResponse;
    if (!data.rate_limit) {
      return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
    }

    if (data.rate_limit.limit_reached === false) {
      return { cooldownMs: WHAM_BURST_COOLDOWN_MS, reason: "wham_burst_contention" };
    }

    const now = Date.now();
    const primaryResetMs = resolveWhamResetMs(data.rate_limit.primary_window, now);
    const secondaryResetMs = resolveWhamResetMs(data.rate_limit.secondary_window, now);

    if (!data.rate_limit.secondary_window) {
      if (primaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: Math.min(Math.floor(primaryResetMs / 2), WHAM_PERSONAL_MAX_COOLDOWN_MS),
        reason: "wham_personal_rolling",
      };
    }

    if (isWhamWindowExhausted(data.rate_limit.secondary_window)) {
      if (secondaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: Math.min(Math.floor(secondaryResetMs / 2), WHAM_TEAM_WEEKLY_MAX_COOLDOWN_MS),
        reason: "wham_team_weekly",
      };
    }

    if (isWhamWindowExhausted(data.rate_limit.primary_window)) {
      if (primaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: Math.min(Math.floor(primaryResetMs / 2), WHAM_TEAM_ROLLING_MAX_COOLDOWN_MS),
        reason: "wham_team_rolling",
      };
    }

    return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
  } catch {
    return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
  } finally {
    clearTimeout(timeout);
  }
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

function isActiveUnusableWindow(until: number | undefined, now: number): boolean {
  return typeof until === "number" && Number.isFinite(until) && until > 0 && now < until;
}

/**
 * Infer the most likely reason all candidate profiles are currently unavailable.
 *
 * We prefer explicit active `disabledReason` values (for example billing/auth)
 * over generic cooldown buckets, then fall back to failure-count signals.
 */
export function resolveProfilesUnavailableReason(params: {
  store: AuthProfileStore;
  profileIds: string[];
  now?: number;
}): AuthProfileFailureReason | null {
  const now = params.now ?? Date.now();
  const scores = new Map<AuthProfileFailureReason, number>();
  const addScore = (reason: AuthProfileFailureReason, value: number) => {
    if (!FAILURE_REASON_SET.has(reason) || value <= 0 || !Number.isFinite(value)) {
      return;
    }
    scores.set(reason, (scores.get(reason) ?? 0) + value);
  };

  for (const profileId of params.profileIds) {
    const stats = params.store.usageStats?.[profileId];
    if (!stats) {
      continue;
    }

    const disabledActive = isActiveUnusableWindow(stats.disabledUntil, now);
    if (disabledActive && stats.disabledReason && FAILURE_REASON_SET.has(stats.disabledReason)) {
      // Disabled reasons are explicit and high-signal; weight heavily.
      addScore(stats.disabledReason, 1_000);
      continue;
    }

    const cooldownActive = isActiveUnusableWindow(stats.cooldownUntil, now);
    if (!cooldownActive) {
      continue;
    }

    let recordedReason = false;
    for (const [rawReason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
      const reason = rawReason as AuthProfileFailureReason;
      const count = typeof rawCount === "number" ? rawCount : 0;
      if (!FAILURE_REASON_SET.has(reason) || count <= 0) {
        continue;
      }
      addScore(reason, count);
      recordedReason = true;
    }
    if (!recordedReason) {
      // No failure counts recorded for this cooldown window. Previously this
      // defaulted to "rate_limit", which caused false "rate limit reached"
      // warnings when the actual reason was unknown (e.g. transient network
      // blip or server error without a classified failure count).
      addScore("unknown", 1);
    }
  }

  if (scores.size === 0) {
    return null;
  }

  let best: AuthProfileFailureReason | null = null;
  let bestScore = -1;
  let bestPriority = Number.MAX_SAFE_INTEGER;
  for (const reason of FAILURE_REASON_PRIORITY) {
    const score = scores.get(reason);
    if (typeof score !== "number") {
      continue;
    }
    const priority = FAILURE_REASON_ORDER.get(reason) ?? Number.MAX_SAFE_INTEGER;
    if (score > bestScore || (score === bestScore && priority < bestPriority)) {
      best = reason;
      bestScore = score;
      bestPriority = priority;
    }
  }
  return best;
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

function shouldBypassModelScopedCooldown(
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
 * Clear expired cooldowns from all profiles in the store.
 *
 * When `cooldownUntil` or `disabledUntil` has passed, the corresponding fields
 * are removed and error counters are reset so the profile gets a fresh start
 * (circuit-breaker half-open → closed). Without this, a stale `errorCount`
 * causes the *next* transient failure to immediately escalate to a much longer
 * cooldown — the root cause of profiles appearing "stuck" after rate limits.
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
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) {
        return false;
      }
      updateUsageStatsEntry(freshStore, profileId, (existing) =>
        resetUsageStats(existing, { lastUsed: Date.now() }),
      );
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  updateUsageStatsEntry(store, profileId, (existing) =>
    resetUsageStats(existing, { lastUsed: Date.now() }),
  );
  authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) {
    return 30_000; // 30 seconds
  }
  if (normalized <= 2) {
    return 60_000; // 1 minute
  }
  return 5 * 60_000; // 5 minutes max
}

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  authPermanentBackoffMs: number;
  authPermanentMaxMs: number;
  failureWindowMs: number;
};

type DisabledFailureReason = Extract<AuthProfileFailureReason, "billing" | "auth_permanent">;

type DisabledFailureBackoffPolicy = {
  baseMs: (cfg: ResolvedAuthCooldownConfig) => number;
  maxMs: (cfg: ResolvedAuthCooldownConfig) => number;
};

const DISABLED_FAILURE_BACKOFF_POLICIES = {
  billing: {
    baseMs: (cfg) => cfg.billingBackoffMs,
    maxMs: (cfg) => cfg.billingMaxMs,
  },
  auth_permanent: {
    // Keep high-confidence permanent-auth failures in the disabled lane, but
    // recover much sooner than billing because some providers surface
    // auth-looking payloads transiently during incidents.
    baseMs: (cfg) => cfg.authPermanentBackoffMs,
    maxMs: (cfg) => cfg.authPermanentMaxMs,
  },
} as const satisfies Record<DisabledFailureReason, DisabledFailureBackoffPolicy>;

function resolveAuthCooldownConfig(params: {
  cfg?: OpenClawConfig;
  providerId: string;
}): ResolvedAuthCooldownConfig {
  const defaults = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    authPermanentBackoffMinutes: 10,
    authPermanentMaxMinutes: 60,
    failureWindowHours: 24,
  } as const;

  const resolvePositiveNumber = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  const cooldowns = params.cfg?.auth?.cooldowns;
  const billingOverride = (() => {
    const map = cooldowns?.billingBackoffHoursByProvider;
    if (!map) {
      return undefined;
    }
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === params.providerId) {
        return value;
      }
    }
    return undefined;
  })();

  const billingBackoffHours = resolvePositiveNumber(
    billingOverride ?? cooldowns?.billingBackoffHours,
    defaults.billingBackoffHours,
  );
  const billingMaxHours = resolvePositiveNumber(
    cooldowns?.billingMaxHours,
    defaults.billingMaxHours,
  );
  const authPermanentBackoffMinutes = resolvePositiveNumber(
    cooldowns?.authPermanentBackoffMinutes,
    defaults.authPermanentBackoffMinutes,
  );
  const authPermanentMaxMinutes = resolvePositiveNumber(
    cooldowns?.authPermanentMaxMinutes,
    defaults.authPermanentMaxMinutes,
  );
  const failureWindowHours = resolvePositiveNumber(
    cooldowns?.failureWindowHours,
    defaults.failureWindowHours,
  );

  return {
    billingBackoffMs: billingBackoffHours * 60 * 60 * 1000,
    billingMaxMs: billingMaxHours * 60 * 60 * 1000,
    authPermanentBackoffMs: authPermanentBackoffMinutes * 60 * 1000,
    authPermanentMaxMs: authPermanentMaxMinutes * 60 * 1000,
    failureWindowMs: failureWindowHours * 60 * 60 * 1000,
  };
}

function calculateDisabledLaneBackoffMs(params: {
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

function resolveDisabledFailureBackoffMs(params: {
  reason: DisabledFailureReason;
  errorCount: number;
  cfgResolved: ResolvedAuthCooldownConfig;
}): number {
  const policy = DISABLED_FAILURE_BACKOFF_POLICIES[params.reason];
  return calculateDisabledLaneBackoffMs({
    errorCount: params.errorCount,
    baseMs: policy.baseMs(params.cfgResolved),
    maxMs: policy.maxMs(params.cfgResolved),
  });
}

export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
): number | null {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return null;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return null;
  }
  return resolveProfileUnusableUntil(stats);
}

function resetUsageStats(
  existing: ProfileUsageStats | undefined,
  overrides?: Partial<ProfileUsageStats>,
): ProfileUsageStats {
  return {
    ...existing,
    errorCount: 0,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownModel: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    ...overrides,
  };
}

function updateUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  updater: (existing: ProfileUsageStats | undefined) => ProfileUsageStats,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = updater(store.usageStats[profileId]);
}

function keepActiveWindowOrRecompute(params: {
  existingUntil: number | undefined;
  now: number;
  recomputedUntil: number;
}): number {
  const { existingUntil, now, recomputedUntil } = params;
  const hasActiveWindow =
    typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now;
  return hasActiveWindow ? existingUntil : recomputedUntil;
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
  modelId?: string;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  // If the previous cooldown has already expired, reset error counters so the
  // profile gets a fresh backoff window. clearExpiredCooldowns() does this
  // in-memory during profile ordering, but the on-disk state may still carry
  // the old counters when the lock-based updater reads a fresh store. Without
  // this check, stale error counts from an expired cooldown cause the next
  // failure to escalate to a much longer cooldown (e.g. 1 min → 25 min).
  const unusableUntil = resolveProfileUnusableUntil(params.existing);
  const previousCooldownExpired = typeof unusableUntil === "number" && params.now >= unusableUntil;

  const shouldResetCounters = windowExpired || previousCooldownExpired;
  const baseErrorCount = shouldResetCounters ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = shouldResetCounters ? {} : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  const disabledFailureReason =
    params.reason === "billing" || params.reason === "auth_permanent" ? params.reason : null;

  if (disabledFailureReason) {
    const disableCount = failureCounts[disabledFailureReason] ?? 1;
    const backoffMs = resolveDisabledFailureBackoffMs({
      reason: disabledFailureReason,
      errorCount: disableCount,
      cfgResolved: params.cfgResolved,
    });
    // Keep active disable windows immutable so retries within the window cannot
    // extend recovery time indefinitely.
    updatedStats.disabledUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.disabledUntil,
      now: params.now,
      recomputedUntil: params.now + backoffMs,
    });
    updatedStats.disabledReason = disabledFailureReason;
  } else {
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    // Keep active cooldown windows immutable so retries within the window
    // cannot push recovery further out.
    updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.cooldownUntil,
      now: params.now,
      recomputedUntil: params.now + backoffMs,
    });
    // Update cooldown metadata based on whether the window is still active
    // and whether the same or a different model is failing.
    const existingCooldownActive =
      typeof params.existing.cooldownUntil === "number" &&
      params.existing.cooldownUntil > params.now;
    if (existingCooldownActive) {
      // Always use the latest failure reason so that downstream consumers
      // (e.g. isProfileInCooldown model-bypass) see the most recent signal.
      // A non-rate_limit failure (auth, billing, …) is profile-wide, so
      // upgrading from rate_limit → auth correctly blocks all models.
      updatedStats.cooldownReason = params.reason;
      // If a different model fails during an active window, widen the scope
      // to all models (undefined) so neither model bypasses the cooldown.
      if (
        params.existing.cooldownModel &&
        params.modelId &&
        params.existing.cooldownModel !== params.modelId
      ) {
        updatedStats.cooldownModel = undefined;
      } else if (
        params.reason === "rate_limit" &&
        !params.modelId &&
        params.existing.cooldownModel
      ) {
        // Unknown originating model during an active model-scoped cooldown:
        // widen scope conservatively so no model can bypass on stale metadata.
        updatedStats.cooldownModel = undefined;
      } else if (params.reason !== "rate_limit") {
        // Non-rate-limit failures are profile-wide — clear model scope even
        // when the same model fails, so that no model can bypass.
        updatedStats.cooldownModel = undefined;
      } else {
        updatedStats.cooldownModel = params.existing.cooldownModel;
      }
    } else {
      updatedStats.cooldownReason = params.reason;
      updatedStats.cooldownModel = params.reason === "rate_limit" ? params.modelId : undefined;
    }
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing and permanent-auth
 * failures are treated as "disabled" (longer backoff) vs the regular cooldown
 * window.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg, runId, modelId } = params;
  const profile = store.profiles[profileId];
  if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) {
    return;
  }

  const whamResult = shouldProbeWhamForFailure(profile.provider, reason)
    ? await probeWhamForCooldown(store, profileId)
    : null;

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || isAuthCooldownBypassedForProvider(profile.provider)) {
        return false;
      }
      const now = Date.now();
      const providerKey = normalizeProviderId(profile.provider);
      const cfgResolved = resolveAuthCooldownConfig({
        cfg,
        providerId: providerKey,
      });

      previousStats = freshStore.usageStats?.[profileId];
      updateTime = now;
      const computed = computeNextProfileUsageStats({
        existing: previousStats ?? {},
        now,
        reason,
        cfgResolved,
        modelId,
      });
      nextStats =
        whamResult && shouldProbeWhamForFailure(profile.provider, reason)
          ? applyWhamCooldownResult({
              existing: previousStats ?? {},
              computed,
              now,
              whamResult,
            })
          : computed;
      updateUsageStatsEntry(freshStore, profileId, () => nextStats ?? computed);
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    if (nextStats) {
      logAuthProfileFailureStateChange({
        runId,
        profileId,
        provider: profile.provider,
        reason,
        previous: previousStats,
        next: nextStats,
        now: updateTime,
      });
    }
    return;
  }
  if (!store.profiles[profileId]) {
    return;
  }

  const now = Date.now();
  const providerKey = normalizeProviderId(store.profiles[profileId]?.provider ?? "");
  const cfgResolved = resolveAuthCooldownConfig({
    cfg,
    providerId: providerKey,
  });

  previousStats = store.usageStats?.[profileId];
  const computed = computeNextProfileUsageStats({
    existing: previousStats ?? {},
    now,
    reason,
    cfgResolved,
    modelId,
  });
  nextStats =
    whamResult && shouldProbeWhamForFailure(store.profiles[profileId]?.provider, reason)
      ? applyWhamCooldownResult({
          existing: previousStats ?? {},
          computed,
          now,
          whamResult,
        })
      : computed;
  updateUsageStatsEntry(store, profileId, () => nextStats ?? computed);
  authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
  logAuthProfileFailureStateChange({
    runId,
    profileId,
    provider: store.profiles[profileId]?.provider ?? profile.provider,
    reason,
    previous: previousStats,
    next: nextStats,
    now,
  });
}

/**
 * Mark a profile as transiently failed. Applies stepped backoff cooldown.
 * Cooldown times: 30s, 1min, 5min (capped).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  runId?: string;
}): Promise<void> {
  await markAuthProfileFailure({
    store: params.store,
    profileId: params.profileId,
    reason: "unknown",
    agentDir: params.agentDir,
    runId: params.runId,
  });
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[profileId]) {
        return false;
      }

      updateUsageStatsEntry(freshStore, profileId, (existing) => resetUsageStats(existing));
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    return;
  }
  if (!store.usageStats?.[profileId]) {
    return;
  }

  updateUsageStatsEntry(store, profileId, (existing) => resetUsageStats(existing));
  authProfileUsageDeps.saveAuthProfileStore(store, agentDir);
}
