import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  AuthProfileBlockedReason,
  AuthProfileBlockedSource,
  AuthProfileCooldownClassification,
  AuthProfileFailureReason,
  ProfileUsageStats,
} from "./types.js";

const AUTH_FAILURE_REASONS = new Set<AuthProfileFailureReason>([
  "auth",
  "auth_permanent",
  "format",
  "overloaded",
  "rate_limit",
  "billing",
  "timeout",
  "model_not_found",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
]);
const AUTH_COOLDOWN_CLASSIFICATIONS = new Set<AuthProfileCooldownClassification>([
  "wham_token_expired",
  "wham_account_dead",
]);
const AUTH_BLOCKED_REASONS = new Set<AuthProfileBlockedReason>(["subscription_limit"]);
const AUTH_BLOCKED_SOURCES = new Set<AuthProfileBlockedSource>(["codex_rate_limits", "wham"]);

function normalizeEnumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T | undefined {
  for (const candidate of allowed) {
    if (candidate === value) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeFailureCounts(raw: unknown): ProfileUsageStats["failureCounts"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: NonNullable<ProfileUsageStats["failureCounts"]> = {};
  for (const [rawReason, count] of Object.entries(raw)) {
    const reason = normalizeEnumValue(rawReason, AUTH_FAILURE_REASONS);
    if (reason === undefined) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    normalized[reason] = Math.trunc(count);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Normalizes one credential owner's persisted cooldown and usage record. */
export function coerceProfileUsageStats(raw: unknown): ProfileUsageStats | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const cooldownReason = normalizeEnumValue(raw.cooldownReason, AUTH_FAILURE_REASONS);
  const cooldownClassification = normalizeEnumValue(
    raw.cooldownClassification,
    AUTH_COOLDOWN_CLASSIFICATIONS,
  );
  const stats: ProfileUsageStats = {};
  function setStat<K extends keyof ProfileUsageStats>(key: K, value: ProfileUsageStats[K]): void {
    if (value !== undefined) {
      stats[key] = value;
    }
  }
  setStat("lastUsed", asFiniteNumber(raw.lastUsed));
  setStat("blockedUntil", asFiniteNumber(raw.blockedUntil));
  setStat("blockedReason", normalizeEnumValue(raw.blockedReason, AUTH_BLOCKED_REASONS));
  setStat("blockedSource", normalizeEnumValue(raw.blockedSource, AUTH_BLOCKED_SOURCES));
  setStat("blockedModel", normalizeOptionalString(raw.blockedModel));
  setStat("blockedScope", raw.blockedScope === "model" ? "model" : undefined);
  setStat("cooldownUntil", asFiniteNumber(raw.cooldownUntil));
  setStat("cooldownReason", cooldownReason);
  setStat(
    "cooldownClassification",
    (cooldownClassification === "wham_token_expired" && cooldownReason === "auth") ||
      (cooldownClassification === "wham_account_dead" && cooldownReason === "auth_permanent")
      ? cooldownClassification
      : undefined,
  );
  setStat("cooldownModel", normalizeOptionalString(raw.cooldownModel));
  setStat("disabledUntil", asFiniteNumber(raw.disabledUntil));
  setStat("disabledReason", normalizeEnumValue(raw.disabledReason, AUTH_FAILURE_REASONS));
  setStat("errorCount", asFiniteNumber(raw.errorCount));
  setStat("failureCounts", normalizeFailureCounts(raw.failureCounts));
  setStat("lastFailureAt", asFiniteNumber(raw.lastFailureAt));
  setStat("lastProbeAt", asFiniteNumber(raw.lastProbeAt));
  return Object.keys(stats).length > 0 ? stats : undefined;
}
