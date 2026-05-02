import { parseByteSize } from "../../cli/parse-bytes.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "../../shared/string-coerce.js";
import type { SessionMaintenanceConfig, SessionMaintenanceMode } from "../types.base.js";
import { parseSessionThreadInfoFast } from "./thread-info.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store");

const DEFAULT_SESSION_PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 500;
const DEFAULT_SESSION_MAINTENANCE_MODE: SessionMaintenanceMode = "enforce";
const DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO = 0.8;
const STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES = 49;
const MIN_BATCHED_ENTRY_MAINTENANCE_SLACK = 25;
const BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO = 0.1;

export type SessionMaintenanceWarning = {
  activeSessionKey: string;
  activeUpdatedAt?: number;
  totalEntries: number;
  pruneAfterMs: number;
  maxEntries: number;
  wouldPrune: boolean;
  wouldCap: boolean;
};

export type ResolvedSessionMaintenanceConfig = {
  mode: SessionMaintenanceMode;
  pruneAfterMs: number;
  maxEntries: number;
  resetArchiveRetentionMs: number | null;
  maxDiskBytes: number | null;
  highWaterBytes: number | null;
};

function resolvePruneAfterMs(maintenance?: SessionMaintenanceConfig): number {
  const raw = maintenance?.pruneAfter ?? maintenance?.pruneDays;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return DEFAULT_SESSION_PRUNE_AFTER_MS;
  }
}

function resolveResetArchiveRetentionMs(
  maintenance: SessionMaintenanceConfig | undefined,
  pruneAfterMs: number,
): number | null {
  const raw = maintenance?.resetArchiveRetention;
  if (raw === false) {
    return null;
  }
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return pruneAfterMs;
  }
  try {
    return parseDurationMs(normalized, { defaultUnit: "d" });
  } catch {
    return pruneAfterMs;
  }
}

function resolveMaxDiskBytes(maintenance?: SessionMaintenanceConfig): number | null {
  const raw = maintenance?.maxDiskBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return null;
  }
  try {
    return parseByteSize(normalized, { defaultUnit: "b" });
  } catch {
    return null;
  }
}

function resolveHighWaterBytes(
  maintenance: SessionMaintenanceConfig | undefined,
  maxDiskBytes: number | null,
): number | null {
  const computeDefault = () => {
    if (maxDiskBytes == null) {
      return null;
    }
    if (maxDiskBytes <= 0) {
      return 0;
    }
    return Math.max(
      1,
      Math.min(
        maxDiskBytes,
        Math.floor(maxDiskBytes * DEFAULT_SESSION_DISK_BUDGET_HIGH_WATER_RATIO),
      ),
    );
  };
  if (maxDiskBytes == null) {
    return null;
  }
  const raw = maintenance?.highWaterBytes;
  const normalized = normalizeStringifiedOptionalString(raw);
  if (!normalized) {
    return computeDefault();
  }
  try {
    const parsed = parseByteSize(normalized, { defaultUnit: "b" });
    return Math.min(parsed, maxDiskBytes);
  } catch {
    return computeDefault();
  }
}

/**
 * Resolve maintenance settings from openclaw.json (`session.maintenance`).
 * Falls back to built-in defaults when config is missing or unset.
 */
export function resolveMaintenanceConfigFromInput(
  maintenance?: SessionMaintenanceConfig,
): ResolvedSessionMaintenanceConfig {
  const pruneAfterMs = resolvePruneAfterMs(maintenance);
  const maxDiskBytes = resolveMaxDiskBytes(maintenance);
  return {
    mode: maintenance?.mode ?? DEFAULT_SESSION_MAINTENANCE_MODE,
    pruneAfterMs,
    maxEntries: maintenance?.maxEntries ?? DEFAULT_SESSION_MAX_ENTRIES,
    resetArchiveRetentionMs: resolveResetArchiveRetentionMs(maintenance, pruneAfterMs),
    maxDiskBytes,
    highWaterBytes: resolveHighWaterBytes(maintenance, maxDiskBytes),
  };
}

export function resolveSessionEntryMaintenanceHighWater(maxEntries: number): number {
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    return 1;
  }
  if (maxEntries <= STRICT_ENTRY_MAINTENANCE_MAX_ENTRIES) {
    return maxEntries + 1;
  }
  const slack = Math.max(
    MIN_BATCHED_ENTRY_MAINTENANCE_SLACK,
    Math.ceil(maxEntries * BATCHED_ENTRY_MAINTENANCE_SLACK_RATIO),
  );
  return maxEntries + slack;
}

export function shouldRunSessionEntryMaintenance(params: {
  entryCount: number;
  maxEntries: number;
  force?: boolean;
}): boolean {
  if (params.force) {
    return true;
  }
  return params.entryCount >= resolveSessionEntryMaintenanceHighWater(params.maxEntries);
}

/**
 * Remove entries whose `updatedAt` is older than the configured threshold.
 * Entries without `updatedAt` are kept (cannot determine staleness).
 * Mutates `store` in-place.
 */
export function pruneStaleEntries(
  store: Record<string, SessionEntry>,
  overrideMaxAgeMs?: number,
  opts: {
    log?: boolean;
    onPruned?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  const maxAgeMs = overrideMaxAgeMs ?? resolveMaintenanceConfigFromInput().pruneAfterMs;
  const cutoffMs = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, entry] of Object.entries(store)) {
    if (shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: opts.preserveKeys })) {
      continue;
    }
    if (entry?.updatedAt != null && entry.updatedAt < cutoffMs) {
      opts.onPruned?.({ key, entry });
      delete store[key];
      pruned++;
    }
  }
  if (pruned > 0 && opts.log !== false) {
    log.info("pruned stale session entries", { pruned, maxAgeMs });
  }
  return pruned;
}

function getEntryUpdatedAt(entry?: SessionEntry): number {
  return entry?.updatedAt ?? Number.NEGATIVE_INFINITY;
}

function isSyntheticSessionMaintenanceKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return (
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey) ||
    isCronSessionKey(sessionKey) ||
    rest.startsWith("hook:") ||
    rest.startsWith("node:") ||
    rest === "heartbeat" ||
    rest.endsWith(":heartbeat") ||
    rest.includes(":heartbeat:")
  );
}

function isTelegramTopicSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return /^telegram:(?:group|channel|direct|dm):.+:topic:[^:]+$/.test(rest);
}

function isExternalGroupOrChannelSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = normalizeLowercaseStringOrEmpty(parsed?.rest ?? sessionKey);
  return /^[^:]+:(?:group|channel):.+$/.test(rest);
}

export function isProtectedSessionMaintenanceEntry(
  sessionKey: string,
  entry: SessionEntry | undefined,
): boolean {
  if (isSyntheticSessionMaintenanceKey(sessionKey)) {
    return false;
  }
  if (parseSessionThreadInfoFast(sessionKey).threadId) {
    return true;
  }
  if (isTelegramTopicSessionKey(sessionKey)) {
    return true;
  }
  if (isExternalGroupOrChannelSessionKey(sessionKey)) {
    return true;
  }
  const chatType = normalizeLowercaseStringOrEmpty(entry?.chatType ?? entry?.origin?.chatType);
  return chatType === "group" || chatType === "channel" || chatType === "thread";
}

function shouldPreserveMaintenanceEntry(params: {
  key: string;
  entry: SessionEntry | undefined;
  preserveKeys?: ReadonlySet<string>;
}): boolean {
  return (
    params.preserveKeys?.has(params.key) === true ||
    isProtectedSessionMaintenanceEntry(params.key, params.entry)
  );
}

export function getActiveSessionMaintenanceWarning(params: {
  store: Record<string, SessionEntry>;
  activeSessionKey: string;
  pruneAfterMs: number;
  maxEntries: number;
  nowMs?: number;
}): SessionMaintenanceWarning | null {
  const activeSessionKey = params.activeSessionKey.trim();
  if (!activeSessionKey) {
    return null;
  }
  const activeEntry = params.store[activeSessionKey];
  if (!activeEntry) {
    return null;
  }
  if (isProtectedSessionMaintenanceEntry(activeSessionKey, activeEntry)) {
    return null;
  }
  const now = params.nowMs ?? Date.now();
  const cutoffMs = now - params.pruneAfterMs;
  const wouldPrune = activeEntry.updatedAt != null ? activeEntry.updatedAt < cutoffMs : false;
  const keys = Object.keys(params.store);
  const wouldCap = wouldCapActiveSession({
    store: params.store,
    keys,
    activeEntry,
    activeSessionKey,
    maxEntries: params.maxEntries,
  });

  if (!wouldPrune && !wouldCap) {
    return null;
  }

  return {
    activeSessionKey,
    activeUpdatedAt: activeEntry.updatedAt,
    totalEntries: keys.length,
    pruneAfterMs: params.pruneAfterMs,
    maxEntries: params.maxEntries,
    wouldPrune,
    wouldCap,
  };
}

function wouldCapActiveSession(params: {
  store: Record<string, SessionEntry>;
  keys: string[];
  activeEntry: SessionEntry;
  activeSessionKey: string;
  maxEntries: number;
}): boolean {
  if (params.keys.length <= params.maxEntries) {
    return false;
  }
  if (params.maxEntries <= 0) {
    return true;
  }

  const protectedCount = params.keys.filter(
    (key) =>
      key !== params.activeSessionKey && isProtectedSessionMaintenanceEntry(key, params.store[key]),
  ).length;
  const maxRemovableEntries = Math.max(0, params.maxEntries - protectedCount);
  if (maxRemovableEntries <= 0) {
    return true;
  }

  const activeUpdatedAt = getEntryUpdatedAt(params.activeEntry);
  let newerOrTieBeforeActive = 0;
  let seenActive = false;
  for (const key of params.keys) {
    if (key === params.activeSessionKey) {
      seenActive = true;
      continue;
    }
    if (isProtectedSessionMaintenanceEntry(key, params.store[key])) {
      continue;
    }
    const entryUpdatedAt = getEntryUpdatedAt(params.store[key]);
    if (entryUpdatedAt > activeUpdatedAt || (!seenActive && entryUpdatedAt === activeUpdatedAt)) {
      newerOrTieBeforeActive++;
      if (newerOrTieBeforeActive >= maxRemovableEntries) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Cap the store to the N most recently updated entries.
 * Entries without `updatedAt` are sorted last (removed first when over limit).
 * Mutates `store` in-place.
 */
export function capEntryCount(
  store: Record<string, SessionEntry>,
  overrideMax?: number,
  opts: {
    log?: boolean;
    onCapped?: (params: { key: string; entry: SessionEntry }) => void;
    preserveKeys?: ReadonlySet<string>;
  } = {},
): number {
  const maxEntries = overrideMax ?? resolveMaintenanceConfigFromInput().maxEntries;
  const preservedCount = Object.entries(store).filter(([key, entry]) =>
    shouldPreserveMaintenanceEntry({ key, entry, preserveKeys: opts.preserveKeys }),
  ).length;
  const maxRemovableEntries = Math.max(0, maxEntries - preservedCount);
  const keys = Object.keys(store).filter(
    (key) =>
      !shouldPreserveMaintenanceEntry({
        key,
        entry: store[key],
        preserveKeys: opts.preserveKeys,
      }),
  );
  if (keys.length <= maxRemovableEntries) {
    return 0;
  }

  // Sort by updatedAt descending; entries without updatedAt go to the end (removed first).
  const sorted = keys.toSorted((a, b) => {
    const aTime = getEntryUpdatedAt(store[a]);
    const bTime = getEntryUpdatedAt(store[b]);
    return bTime - aTime;
  });

  const toRemove = sorted.slice(maxRemovableEntries);
  for (const key of toRemove) {
    const entry = store[key];
    if (entry) {
      opts.onCapped?.({ key, entry });
    }
    delete store[key];
  }
  if (opts.log !== false) {
    log.info("capped session entry count", { removed: toRemove.length, maxEntries });
  }
  return toRemove.length;
}
