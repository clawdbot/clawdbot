import fs from "node:fs";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeProviderId } from "../provider-id.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthStatePath } from "./paths.js";
import type {
  AuthProfileBlockedReason,
  AuthProfileBlockedSource,
  AuthProfileFailureReason,
  AuthProfileState,
  AuthProfileStateStore,
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
const AUTH_BLOCKED_REASONS = new Set<AuthProfileBlockedReason>(["subscription_limit"]);
const AUTH_BLOCKED_SOURCES = new Set<AuthProfileBlockedSource>(["codex_rate_limits", "wham"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEnumValue<T extends string>(value: unknown, allowed: Set<T>): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return allowed.has(value as T) ? (value as T) : undefined;
}

function normalizeFailureCounts(raw: unknown): ProfileUsageStats["failureCounts"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: NonNullable<ProfileUsageStats["failureCounts"]> = {};
  for (const [reason, count] of Object.entries(raw)) {
    if (!AUTH_FAILURE_REASONS.has(reason as AuthProfileFailureReason)) {
      continue;
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
      continue;
    }
    normalized[reason as AuthProfileFailureReason] = Math.trunc(count);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeAuthProfileOrder(raw: unknown): AuthProfileState["order"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized = Object.entries(raw).reduce<Record<string, string[]>>(
    (acc, [provider, value]) => {
      if (!Array.isArray(value)) {
        return acc;
      }
      const providerKey = normalizeProviderId(provider);
      if (!providerKey) {
        return acc;
      }
      const list = value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
      if (list.length > 0) {
        acc[providerKey] = list;
      }
      return acc;
    },
    {},
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLastGood(raw: unknown): AuthProfileState["lastGood"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [provider, profileId] of Object.entries(raw)) {
    const providerKey = normalizeProviderId(provider);
    const normalizedProfileId = normalizeOptionalString(profileId);
    if (!providerKey || !normalizedProfileId) {
      continue;
    }
    normalized[providerKey] = normalizedProfileId;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeUsageStatsEntry(raw: unknown): ProfileUsageStats | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const stats: ProfileUsageStats = {
    lastUsed: normalizeFiniteNumber(raw.lastUsed),
    blockedUntil: normalizeFiniteNumber(raw.blockedUntil),
    blockedReason: normalizeEnumValue(raw.blockedReason, AUTH_BLOCKED_REASONS),
    blockedSource: normalizeEnumValue(raw.blockedSource, AUTH_BLOCKED_SOURCES),
    blockedModel: normalizeOptionalString(raw.blockedModel),
    cooldownUntil: normalizeFiniteNumber(raw.cooldownUntil),
    cooldownReason: normalizeEnumValue(raw.cooldownReason, AUTH_FAILURE_REASONS),
    cooldownModel: normalizeOptionalString(raw.cooldownModel),
    disabledUntil: normalizeFiniteNumber(raw.disabledUntil),
    disabledReason: normalizeEnumValue(raw.disabledReason, AUTH_FAILURE_REASONS),
    errorCount: normalizeFiniteNumber(raw.errorCount),
    failureCounts: normalizeFailureCounts(raw.failureCounts),
    lastFailureAt: normalizeFiniteNumber(raw.lastFailureAt),
  };
  for (const key of Object.keys(stats) as Array<keyof ProfileUsageStats>) {
    if (stats[key] === undefined) {
      delete stats[key];
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function normalizeUsageStats(raw: unknown): AuthProfileState["usageStats"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, ProfileUsageStats> = {};
  for (const [profileId, value] of Object.entries(raw)) {
    const normalizedProfileId = normalizeOptionalString(profileId);
    const stats = normalizeUsageStatsEntry(value);
    if (!normalizedProfileId || !stats) {
      continue;
    }
    normalized[normalizedProfileId] = stats;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function coerceAuthProfileState(raw: unknown): AuthProfileState {
  if (!isRecord(raw)) {
    return {};
  }
  return {
    order: normalizeAuthProfileOrder(raw.order),
    lastGood: normalizeLastGood(raw.lastGood),
    usageStats: normalizeUsageStats(raw.usageStats),
  };
}

export function mergeAuthProfileState(
  base: AuthProfileState,
  override: AuthProfileState,
): AuthProfileState {
  const mergeRecord = <T>(left?: Record<string, T>, right?: Record<string, T>) => {
    if (!left && !right) {
      return undefined;
    }
    if (!left) {
      return { ...right };
    }
    if (!right) {
      return { ...left };
    }
    return { ...left, ...right };
  };

  return {
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

export function loadPersistedAuthProfileState(agentDir?: string): AuthProfileState {
  return coerceAuthProfileState(loadJsonFile(resolveAuthStatePath(agentDir)));
}

function buildPersistedAuthProfileState(store: AuthProfileState): AuthProfileStateStore | null {
  const state = coerceAuthProfileState(store);
  if (!state.order && !state.lastGood && !state.usageStats) {
    return null;
  }
  return {
    version: AUTH_STORE_VERSION,
    ...(state.order ? { order: state.order } : {}),
    ...(state.lastGood ? { lastGood: state.lastGood } : {}),
    ...(state.usageStats ? { usageStats: state.usageStats } : {}),
  };
}

export function savePersistedAuthProfileState(
  store: AuthProfileState,
  agentDir?: string,
): AuthProfileStateStore | null {
  const payload = buildPersistedAuthProfileState(store);
  const statePath = resolveAuthStatePath(agentDir);
  if (!payload) {
    try {
      fs.unlinkSync(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw error;
      }
    }
    return null;
  }
  saveJsonFile(statePath, payload);
  return payload;
}
