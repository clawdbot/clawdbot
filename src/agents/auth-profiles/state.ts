/**
 * Runtime-state normalization and persistence for auth profile selection.
 * This state tracks order, last-good profile, and cooldown/failure metadata
 * separately from secret-bearing credentials.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { AUTH_STORE_VERSION } from "./constants.js";
import { coerceProfileUsageStats } from "./profile-usage-stats.js";
import { readPersistedAuthProfileStateRaw, type AuthProfileDatabase } from "./sqlite.js";
import type { AuthProfileState, AuthProfileStateStore, ProfileUsageStats } from "./types.js";

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
      const list = normalizeTrimmedStringList(value);
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

function normalizeUsageStats(raw: unknown): AuthProfileState["usageStats"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, ProfileUsageStats> = {};
  for (const [profileId, value] of Object.entries(raw)) {
    const normalizedProfileId = normalizeOptionalString(profileId);
    const stats = coerceProfileUsageStats(value);
    if (!normalizedProfileId || !stats) {
      continue;
    }
    normalized[normalizedProfileId] = stats;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Coerces persisted auth profile runtime state into the current shape. */
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

/** Merges auth profile runtime state, with override records winning per key. */
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

/** Loads persisted auth profile runtime state from SQLite. */
export function loadPersistedAuthProfileState(
  agentDir?: string,
  database?: AuthProfileDatabase,
): AuthProfileState {
  return coerceAuthProfileState(readPersistedAuthProfileStateRaw(agentDir, database));
}

/** Builds the persisted auth profile runtime state payload. */
export function buildPersistedAuthProfileState(
  store: AuthProfileState,
): AuthProfileStateStore | null {
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
