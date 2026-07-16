/**
 * Auth profile usage accounting and cooldown mutation.
 * Records failures under the store lock, applies WHAM usage probes for OpenAI
 * OAuth profiles, and exposes display helpers for unavailable profiles.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromEpochSeconds,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readProviderJsonResponse } from "../provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../provider-request-config.js";
import { notifyAuthProfileFailureHook, setAuthProfileFailureHook } from "./failure-hook.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";

const authProfileUsageLog = createSubsystemLogger("agent/embedded");
import { updateAuthProfileStoreWithLock } from "./store.js";
import type {
  AuthProfileBlockedSource,
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  ProfileUsageStats,
} from "./types.js";
import {
  isActiveUnusableWindow,
  isAuthCooldownBypassedForProvider,
  isModelScopedCooldownReason,
  resolveProfileUnusableUntil,
} from "./usage-state.js";
export {
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
} from "./usage-state.js";

const authProfileUsageDeps = {
  updateAuthProfileStoreWithLock,
};

export { setAuthProfileFailureHook };

/** Test-only dependency injection for usage persistence hooks. */
const testing = {
  setDepsForTest(
    overrides: Partial<{
      updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
    }> | null,
  ) {
    authProfileUsageDeps.updateAuthProfileStoreWithLock =
      overrides?.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  },
  resetWhamReprobeStateForTest() {
    whamReprobesInFlight.clear();
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.authProfileUsageTestApi")] =
    testing;
}

function logDroppedAuthProfileBookkeeping(kind: string, profileId: string): void {
  authProfileUsageLog.warn("dropped auth profile bookkeeping after locked store update failed", {
    event: "auth_profile_bookkeeping_dropped",
    kind,
    profileId,
    tags: ["auth_profiles", "persistence"],
  });
}

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  "auth_permanent",
  "auth",
  "billing",
  "format",
  "model_not_found",
  "overloaded",
  "timeout",
  "rate_limit",
  "empty_response",
  "no_error_details",
  "unclassified",
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
const WHAM_HALF_OPEN_REPROBE_INTERVAL_MS = 45 * 60 * 1000;
const whamReprobesInFlight = new Map<string, Promise<void>>();

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
  available?: true;
  cooldownMs: number;
  reason: string;
  blockedUntil?: number;
  blockedSource?: AuthProfileBlockedSource;
};

function shouldProbeWhamForFailure(
  profile: AuthProfileCredential | undefined,
  reason: AuthProfileFailureReason,
): boolean {
  const normalizedProvider = normalizeProviderId(profile?.provider ?? "");
  return (
    profile?.type === "oauth" &&
    Boolean(profile.access) &&
    // Expired access tokens are routine and refreshable; probing with one
    // guarantees a 401 that looks like a 12h token-family outage.
    isFutureDateTimestampMs(profile.expires) &&
    normalizedProvider === "openai" &&
    (reason === "rate_limit" ||
      reason === "empty_response" ||
      reason === "no_error_details" ||
      reason === "unclassified" ||
      reason === "unknown")
  );
}

function isSameWhamCredential(
  expected: AuthProfileCredential,
  current: AuthProfileCredential | undefined,
): boolean {
  return (
    expected.type === "oauth" &&
    current?.type === "oauth" &&
    normalizeProviderId(expected.provider) === normalizeProviderId(current.provider) &&
    expected.access === current.access &&
    expected.accountId === current.accountId
  );
}

function resolveActiveWindowUntil(value: unknown, now: number): number {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs !== undefined && timestampMs > now ? timestampMs : 0;
}

function resolveUsageWindowUntil(now: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationMs(Math.max(1, Math.floor(durationMs)), { nowMs: now }) ?? now
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
    return positiveSecondsToSafeMilliseconds(window.reset_after_seconds) ?? null;
  }
  if (
    typeof window.reset_at === "number" &&
    Number.isFinite(window.reset_at) &&
    window.reset_at > 0
  ) {
    const resetAtMs = resolveExpiresAtMsFromEpochSeconds(window.reset_at);
    return resetAtMs === undefined ? null : Math.max(0, resetAtMs - now);
  }
  return null;
}

function isWhamWindowExhausted(window: WhamUsageWindow | undefined): boolean {
  return Boolean(
    window &&
    typeof window.used_percent === "number" &&
    Number.isFinite(window.used_percent) &&
    window.used_percent >= 100,
  );
}

function applyWhamCooldownResult(params: {
  existing: ProfileUsageStats;
  computed: ProfileUsageStats;
  now: number;
  whamResult: WhamCooldownProbeResult;
}): ProfileUsageStats {
  const existingCooldownUntil = params.existing.cooldownUntil;
  const existingBlockedUntil = params.existing.blockedUntil;
  const existingActiveCooldownUntil =
    typeof existingCooldownUntil === "number" &&
    Number.isFinite(existingCooldownUntil) &&
    existingCooldownUntil > params.now
      ? existingCooldownUntil
      : 0;
  const existingActiveBlockedUntil =
    typeof existingBlockedUntil === "number" &&
    Number.isFinite(existingBlockedUntil) &&
    existingBlockedUntil > params.now
      ? existingBlockedUntil
      : 0;
  if (params.whamResult.blockedUntil) {
    return {
      ...params.computed,
      lastProbeAt: params.now,
      blockedUntil: Math.max(existingActiveBlockedUntil, params.whamResult.blockedUntil),
      blockedReason: "subscription_limit",
      blockedSource: params.whamResult.blockedSource ?? "wham",
      blockedModel: undefined,
      blockedScope: undefined,
      cooldownUntil: undefined,
      cooldownReason: undefined,
      cooldownModel: undefined,
    };
  }
  return {
    ...params.computed,
    lastProbeAt: params.now,
    cooldownUntil: Math.max(
      existingActiveCooldownUntil,
      resolveUsageWindowUntil(params.now, params.whamResult.cooldownMs),
    ),
  };
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function probeWhamForCooldown(
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
    const version = process.env.OPENCLAW_VERSION?.trim();
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${profile.access}`,
      Accept: "application/json",
      originator: "openclaw",
      ...(version ? { version } : {}),
      "User-Agent": `openclaw/${version || "dev"}`,
    };
    if (profile.accountId) {
      defaultHeaders["ChatGPT-Account-Id"] = profile.accountId;
    }
    const headers =
      resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: WHAM_USAGE_URL,
        capability: "other",
        transport: "http",
        defaultHeaders,
      }) ?? defaultHeaders;

    const res = await fetch(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      await cancelUnreadResponseBody(res);
      if (res.status === 401) {
        return { cooldownMs: WHAM_TOKEN_EXPIRED_COOLDOWN_MS, reason: "wham_token_expired" };
      }
      if (res.status === 403) {
        return { cooldownMs: WHAM_DEAD_ACCOUNT_COOLDOWN_MS, reason: "wham_account_dead" };
      }
      return { cooldownMs: WHAM_HTTP_ERROR_COOLDOWN_MS, reason: "wham_http_error" };
    }

    const data = await readProviderJsonResponse<WhamUsageResponse>(res, "WHAM usage probe");
    if (!data.rate_limit) {
      return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
    }

    if (data.rate_limit.limit_reached === false) {
      return {
        available: true,
        cooldownMs: WHAM_BURST_COOLDOWN_MS,
        reason: "wham_burst_contention",
      };
    }

    const now = Date.now();
    const primaryResetMs = resolveWhamResetMs(data.rate_limit.primary_window, now);
    const secondaryResetMs = resolveWhamResetMs(data.rate_limit.secondary_window, now);

    if (!data.rate_limit.secondary_window) {
      if (primaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: WHAM_BURST_COOLDOWN_MS,
        blockedUntil: resolveUsageWindowUntil(now, primaryResetMs),
        blockedSource: "wham",
        reason: "wham_personal_rolling",
      };
    }

    if (isWhamWindowExhausted(data.rate_limit.secondary_window)) {
      if (secondaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: WHAM_BURST_COOLDOWN_MS,
        blockedUntil: resolveUsageWindowUntil(now, secondaryResetMs),
        blockedSource: "wham",
        reason: "wham_team_weekly",
      };
    }

    if (isWhamWindowExhausted(data.rate_limit.primary_window)) {
      if (primaryResetMs === null) {
        return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS, reason: "wham_probe_failed" };
      }
      return {
        cooldownMs: WHAM_BURST_COOLDOWN_MS,
        blockedUntil: resolveUsageWindowUntil(now, primaryResetMs),
        blockedSource: "wham",
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

function shouldHalfOpenProbeWhamBlock(params: {
  store: AuthProfileStore;
  profileId: string;
  forModel?: string;
  now: number;
}): boolean {
  const profile = params.store.profiles[params.profileId];
  const stats = params.store.usageStats?.[params.profileId];
  if (
    !stats ||
    stats.blockedSource !== "wham" ||
    stats.blockedReason !== "subscription_limit" ||
    !isActiveUnusableWindow(stats.blockedUntil, params.now) ||
    isActiveUnusableWindow(stats.cooldownUntil, params.now) ||
    isActiveUnusableWindow(stats.disabledUntil, params.now) ||
    !shouldProbeWhamForFailure(profile, "rate_limit")
  ) {
    return false;
  }
  if (
    params.forModel &&
    stats.blockedScope === "model" &&
    stats.blockedModel &&
    stats.blockedModel !== params.forModel
  ) {
    return false;
  }
  const remainingMs = (stats.blockedUntil ?? 0) - params.now;
  const sinceLastProbeMs = params.now - (stats.lastProbeAt ?? 0);
  return (
    remainingMs > WHAM_HALF_OPEN_REPROBE_INTERVAL_MS &&
    sinceLastProbeMs >= WHAM_HALF_OPEN_REPROBE_INTERVAL_MS
  );
}

type WhamBlockGeneration = Pick<
  ProfileUsageStats,
  "blockedUntil" | "blockedModel" | "blockedScope" | "lastFailureAt"
> & { rateLimitFailureCount?: number };

function matchesWhamBlockGeneration(
  stats: ProfileUsageStats,
  generation: WhamBlockGeneration,
): boolean {
  return (
    stats.blockedUntil === generation.blockedUntil &&
    stats.blockedModel === generation.blockedModel &&
    stats.blockedScope === generation.blockedScope &&
    stats.lastFailureAt === generation.lastFailureAt &&
    stats.failureCounts?.rate_limit === generation.rateLimitFailureCount
  );
}

async function claimWhamHalfOpenReprobe(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forModel?: string;
  expectedProfile: AuthProfileCredential;
  startedAt: number;
}): Promise<WhamBlockGeneration | null> {
  let generation: WhamBlockGeneration | undefined;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (freshStore) => {
      const currentProfile = freshStore.profiles[params.profileId];
      if (
        !isSameWhamCredential(params.expectedProfile, currentProfile) ||
        !shouldHalfOpenProbeWhamBlock({
          store: freshStore,
          profileId: params.profileId,
          forModel: params.forModel,
          now: params.startedAt,
        })
      ) {
        return false;
      }
      const currentStats = freshStore.usageStats?.[params.profileId];
      if (!currentStats) {
        return false;
      }
      generation = {
        blockedUntil: currentStats.blockedUntil,
        blockedModel: currentStats.blockedModel,
        blockedScope: currentStats.blockedScope,
        lastFailureAt: currentStats.lastFailureAt,
        rateLimitFailureCount: currentStats.failureCounts?.rate_limit,
      };
      updateUsageStatsEntry(freshStore, params.profileId, (existing) => ({
        ...existing,
        lastProbeAt: params.startedAt,
      }));
      return true;
    },
  });
  if (updated && generation) {
    params.store.usageStats = updated.usageStats;
    return generation;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("wham_half_open_claim", params.profileId);
  }
  return null;
}

async function runWhamHalfOpenReprobe(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forModel?: string;
  expectedProfile: AuthProfileCredential;
  startedAt: number;
}): Promise<void> {
  const generation = await claimWhamHalfOpenReprobe(params);
  if (!generation) {
    return;
  }
  const result = await probeWhamForCooldown(params.store, params.profileId);
  if (!result || (!result.available && !result.blockedUntil)) {
    return;
  }
  let applied = false;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (freshStore) => {
      const currentProfile = freshStore.profiles[params.profileId];
      const currentStats = freshStore.usageStats?.[params.profileId];
      if (
        !currentStats ||
        currentStats.blockedSource !== "wham" ||
        currentStats.blockedReason !== "subscription_limit" ||
        currentStats.lastProbeAt !== params.startedAt ||
        !matchesWhamBlockGeneration(currentStats, generation) ||
        !isSameWhamCredential(params.expectedProfile, currentProfile)
      ) {
        return false;
      }
      updateUsageStatsEntry(freshStore, params.profileId, (existing) => {
        if (result.available) {
          return {
            ...existing,
            blockedUntil: undefined,
            blockedReason: undefined,
            blockedSource: undefined,
            blockedModel: undefined,
            blockedScope: undefined,
          };
        }
        if (result.blockedUntil) {
          return {
            ...existing,
            blockedUntil: result.blockedUntil,
            blockedReason: "subscription_limit",
            blockedSource: "wham",
            blockedModel: generation.blockedModel,
            blockedScope: generation.blockedScope,
          };
        }
        return existing ?? {};
      });
      applied = true;
      return true;
    },
  });
  if (updated && applied) {
    params.store.usageStats = updated.usageStats;
  } else if (updated === null) {
    logDroppedAuthProfileBookkeeping("wham_half_open_reprobe", params.profileId);
  }
}

/** Starts bounded background refreshes for long WHAM-only profile blocks. */
export function maybeReprobeWhamBlockedProfiles(params: {
  store: AuthProfileStore;
  profileIds: string[];
  agentDir?: string;
  forModel?: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  for (const profileId of params.profileIds) {
    if (!shouldHalfOpenProbeWhamBlock({ ...params, profileId, now })) {
      continue;
    }
    const profile = params.store.profiles[profileId];
    if (!profile) {
      continue;
    }
    const probeKey = `${params.agentDir ?? "default"}\u0000${profileId}`;
    if (whamReprobesInFlight.has(probeKey)) {
      continue;
    }
    // Keep the current synchronous fallback decision: this attempt still
    // skips. A deduped refresh updates durable state for the next decision.
    const task = runWhamHalfOpenReprobe({
      store: params.store,
      profileId,
      agentDir: params.agentDir,
      forModel: params.forModel,
      expectedProfile: structuredClone(profile),
      startedAt: now,
    })
      .catch((error: unknown) => {
        authProfileUsageLog.warn("WHAM half-open reprobe failed", {
          event: "auth_profile_wham_reprobe_error",
          profileId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        whamReprobesInFlight.delete(probeKey);
      });
    whamReprobesInFlight.set(probeKey, task);
  }
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

    if (isActiveUnusableWindow(stats.blockedUntil, now)) {
      addScore("rate_limit", 1_000);
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

/** Returns the regular transient-failure cooldown duration for an error count. */
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

/** Resolves the display-facing unusable timestamp, honoring provider bypasses. */
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
    blockedUntil: undefined,
    blockedReason: undefined,
    blockedSource: undefined,
    blockedModel: undefined,
    blockedScope: undefined,
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
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
    });
    updatedStats.disabledReason = disabledFailureReason;
  } else {
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    // Keep active cooldown windows immutable so retries within the window
    // cannot push recovery further out.
    updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.cooldownUntil,
      now: params.now,
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
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
        isModelScopedCooldownReason(params.reason) &&
        !params.modelId &&
        params.existing.cooldownModel
      ) {
        // Unknown originating model during an active model-scoped cooldown:
        // widen scope conservatively so no model can bypass on stale metadata.
        updatedStats.cooldownModel = undefined;
      } else if (!isModelScopedCooldownReason(params.reason)) {
        // Profile-wide failures (auth, billing, format, server_error, ...) —
        // clear model scope so that no model can bypass.
        updatedStats.cooldownModel = undefined;
      } else {
        updatedStats.cooldownModel = params.existing.cooldownModel;
      }
    } else {
      updatedStats.cooldownReason = params.reason;
      updatedStats.cooldownModel = isModelScopedCooldownReason(params.reason)
        ? params.modelId
        : undefined;
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

  const shouldProbeWham = shouldProbeWhamForFailure(profile, reason);
  // A detail-less provider failure carries no credential-health evidence.
  // Only OpenAI OAuth can disambiguate it with the canonical WHAM probe.
  if (reason === "no_error_details" && !shouldProbeWham) {
    return;
  }

  const whamResult = shouldProbeWham ? await probeWhamForCooldown(store, profileId) : null;

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profileValue = freshStore.profiles[profileId];
      if (!profileValue || isAuthCooldownBypassedForProvider(profileValue.provider)) {
        return false;
      }
      const currentWhamResult =
        whamResult &&
        shouldProbeWhamForFailure(profileValue, reason) &&
        isSameWhamCredential(profile, profileValue)
          ? whamResult
          : null;
      // The WHAM response belongs to the credential snapshot used for the
      // probe. A concurrent profile replacement must not inherit its result.
      if (reason === "no_error_details" && !currentWhamResult) {
        return false;
      }
      const now = Date.now();
      const providerKey = normalizeProviderId(profileValue.provider);
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
      nextStats = currentWhamResult
        ? applyWhamCooldownResult({
            existing: previousStats ?? {},
            computed,
            now,
            whamResult: currentWhamResult,
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
    try {
      notifyAuthProfileFailureHook();
    } catch (err) {
      // Hook errors must not break failure recording; log and continue.
      authProfileUsageLog.warn("auth profile failure hook threw", {
        event: "auth_profile_failure_hook_error",
        tags: ["error_handling", "auth_profiles"],
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("failure", profileId);
  }
}

function buildBlockedProfileUsageStats(params: {
  previousStats: ProfileUsageStats | undefined;
  blockedUntil: number;
  source: AuthProfileBlockedSource;
  modelId: string | undefined;
  now: number;
}): ProfileUsageStats {
  const activeBlockedUntil = resolveActiveWindowUntil(
    params.previousStats?.blockedUntil,
    params.now,
  );
  // One active block can stay model-scoped only while every observation names
  // that same model. Mixed or unknown observations widen the profile.
  const blockedModel =
    activeBlockedUntil === 0
      ? params.modelId
      : params.previousStats?.blockedScope === "model" &&
          params.previousStats.blockedModel === params.modelId &&
          params.modelId
        ? params.modelId
        : undefined;
  return {
    ...params.previousStats,
    blockedUntil: Math.max(activeBlockedUntil, params.blockedUntil),
    blockedReason: "subscription_limit",
    blockedSource: params.source,
    blockedModel,
    blockedScope: blockedModel ? "model" : undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownModel: undefined,
    lastFailureAt: params.now,
    failureCounts: {
      ...params.previousStats?.failureCounts,
      rate_limit: (params.previousStats?.failureCounts?.rate_limit ?? 0) + 1,
    },
  };
}

/** Marks a profile blocked until a provider-reported reset timestamp. */
export async function markAuthProfileBlockedUntil(params: {
  store: AuthProfileStore;
  profileId: string;
  blockedUntil: number;
  source: AuthProfileBlockedSource;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, profileId, blockedUntil, agentDir, runId, modelId, source } = params;
  const profile = store.profiles[profileId];
  if (
    !profile ||
    isAuthCooldownBypassedForProvider(profile.provider) ||
    !isFutureDateTimestampMs(blockedUntil)
  ) {
    return;
  }

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profileLocal = freshStore.profiles[profileId];
      if (!profileLocal || isAuthCooldownBypassedForProvider(profileLocal.provider)) {
        return false;
      }
      const now = asDateTimestampMs(Date.now());
      if (now === undefined) {
        return false;
      }
      previousStats = freshStore.usageStats?.[profileId];
      updateTime = now;
      nextStats = buildBlockedProfileUsageStats({
        previousStats,
        blockedUntil,
        source,
        modelId,
        now,
      });
      updateUsageStatsEntry(freshStore, profileId, () => nextStats as ProfileUsageStats);
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
        reason: "rate_limit",
        previous: previousStats,
        next: nextStats,
        now: updateTime,
      });
    }
    return;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("blocked_until", profileId);
  }
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
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("clear_cooldown", profileId);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
